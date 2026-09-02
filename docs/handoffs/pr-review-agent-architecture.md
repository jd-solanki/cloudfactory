# PR review automation: discussion handoff

## Purpose

Continue the design discussion for an automated pull-request reviewer that can conditionally implement its own findings.

No implementation has been started. The discussion has focused on Cloudflare Workers, Workflows, Sandboxes, Artifacts, Effect, GitHub labels, and GitHub authentication.

## Requirements stated by the user

- Start an automated review when a pull request is opened or updated.
- Use PR labels as a visible state machine.
- Do not start a fix agent merely because a review comment exists.
- Start a fix agent only when the review contains verified, actionable work.
- Handle the valid outcome where there is nothing to fix.
- Expect some agent runs to take 30 minutes or longer.
- Use Effect for application code.
- Keep the design understandable to someone new to Cloudflare's developer platform.

## Current architecture recommendation

Use the products as separate layers:

```text
GitHub webhook
    -> short-lived HTTP Worker invocation
    -> Cloudflare Workflow instance
    -> Cloudflare Sandbox when a repository checkout or shell is needed
    -> GitHub review, label, or commit
```

- **Worker:** verify the webhook, normalize the event, create a deterministic Workflow instance, return `202`, and finish.
- **Workflow:** durably coordinate steps, retries, decisions, waits, and progress.
- **Sandbox:** provide the isolated Linux filesystem and processes for Git checkout, editing, linting, tests, and builds.
- **Effect:** structure the code inside Worker and Workflow invocations with typed errors, services, layers, retries, and resource scopes.
- **Artifacts:** optional versioned storage for checkpoints or agent work; not required for the first version.

The HTTP Worker should not await the full agent run and should not use `ctx.waitUntil()` for it. After the Worker creates a Workflow and returns, Cloudflare maintains the Workflow as a separate durable execution. A Workflow is not one continuously running server process: Cloudflare persists step results and resumes the instance as needed.

## Proposed label state machine

Keep exactly one `agent:*` state label on the PR while preserving unrelated labels.

```text
none
  -> agent:reviewing
       -> agent:clean
       -> agent:fix-needed
       -> agent:human-needed

agent:fix-needed
  -> agent:fixing
       -> agent:reviewing after a fix commit causes pull_request.synchronize
       -> agent:human-needed when the change is unsafe or cannot be completed
       -> agent:failed on an infrastructure failure
```

Important rules:

- `agent:clean` is a successful terminal outcome for the current head SHA. It must not start a Sandbox fixer.
- A new head SHA supersedes work for the previous SHA and moves the PR back to `agent:reviewing`.
- Closed or merged PRs remove the automation state label and terminate outstanding work.
- Limit automated fix/re-review cycles; two cycles was suggested before moving to `agent:human-needed`.
- Use deterministic Workflow IDs such as `review-{repositoryId}-{prNumber}-{headSha}` and `fix-{repositoryId}-{prNumber}-{headSha}` to deduplicate webhook redeliveries.
- A Durable Object keyed by repository and PR was suggested as a later option if concurrent label transitions need serialization. It is not required for the first version if deterministic IDs and head-SHA checks are sufficient.

Do not use GitHub's set-labels endpoint without preserving existing labels because it replaces the entire label set. Centralize state-label removal and addition in one adapter.

## Review and fix Workflows

Use two independent Cloudflare Workflow classes rather than one Workflow waiting indefinitely for a fix decision.

### Review Workflow

1. Load the PR and confirm its current head SHA.
2. Apply `agent:reviewing`.
3. Fetch the diff.
4. Optionally create a review Sandbox to inspect the full repository and run read-only checks.
5. Produce a structured decision before rendering any GitHub prose.
6. Publish the GitHub review.
7. Apply exactly one result label.

The decision should have three outcomes:

```ts
type ReviewDecision =
  | { verdict: "clean"; headSha: string; findings: [] }
  | { verdict: "autofix"; headSha: string; findings: ActionableFinding[] }
  | { verdict: "human"; headSha: string; findings: Finding[]; reason: string };
```

The review comment is the human-readable rendering of this result. Comment existence is not a control signal. Only the trusted structured `autofix` verdict may produce `agent:fix-needed`.

The review Sandbox is optional when the model only needs the GitHub diff. It becomes useful for repository-wide context, linting, typechecking, and tests.

### Fix Workflow

Trigger it from the transition to `agent:fix-needed`, normally through the GitHub `pull_request:labeled` webhook.

1. Re-fetch the PR and require the expected head SHA.
2. Find the trusted bot review associated with that SHA.
3. Require at least one verified actionable finding.
4. Transition to `agent:fixing`.
5. Create a fresh Sandbox and check out the exact SHA.
6. Let the coding agent edit only the verified findings.
7. Run formatting, linting, typechecking, tests, and secret scanning.
8. Re-fetch the head SHA immediately before pushing.
9. Push without force only if the head is unchanged.
10. Let the resulting `pull_request.synchronize` webhook start a fresh Review Workflow.

The fix Workflow needs a Sandbox or an equivalent build runner. Keep model and GitHub credentials in the Workflow and expose narrowly defined Sandbox file and command tools. Running a complete coding-agent CLI inside the Sandbox is simpler but would usually expose an AI credential to untrusted PR code.

## Effect and Cloudflare Workflows

Keep Cloudflare Workflows even though the application will use Effect.

- Standard Effect fibers, retries, schedules, refs, scopes, and layers are in-process and disappear with the Worker invocation.
- Cloudflare Workflows supply durability across eviction, restarts, deployments, and long waits.
- Run an Effect program inside each `step.do()` callback with `Effect.runPromise`.
- Reconstruct Effect services from `this.env` when a step executes.
- Return only serializable values from Workflow steps; do not expect a Fiber, Ref, Scope, Layer, or Sandbox handle to survive between steps.
- Use Effect retries for small immediate failures and Workflow retries for durable recovery. All retried GitHub writes must be idempotent.

Effect v4 currently has `effect/unstable/workflow`, but it is explicitly unstable. The former Cloudflare adapter was not ported to v4; using it as the durable engine would require maintaining a custom Durable Object adapter. Use Effect inside Cloudflare Workflows.

## Duration and Sandbox lifecycle

Agent tasks may run longer than 30 minutes. Design them accordingly:

- `ctx.waitUntil()` extends an HTTP invocation for only a short period after the response and is unsuitable for the agent.
- Cloudflare documents unlimited wall-clock duration per Workflow step, subject to active CPU, step-count, payload, state, and subrequest limits.
- Waiting for model responses, GitHub requests, storage, or Sandbox commands is I/O rather than continuous Worker CPU.
- Break the agent loop into durable steps or start a deterministic Sandbox process and poll/checkpoint it. Avoid one opaque, non-idempotent 30-minute step.

Do not persist a Sandbox until the PR merges.

- Current Sandbox documentation says an idle container stops after the configured inactivity period and loses files and processes.
- `keepAlive: true` prevents normal sleeping but consumes resources, requires explicit cleanup, and is not durable storage.
- Create a clean Sandbox per review or fix attempt, then destroy it.
- GitHub commits are the durable source of truth. Use R2, D1, or Artifacts for large logs, structured agent state, or work-in-progress checkpoints when necessary.

## Lessons adopted from Astro issue triage

Cloudflare's Astro article describes agents running in GitHub Actions. Cloudflare Workers AI supplies models through its REST endpoint; the example is not a Cloudflare Workflows or Sandbox implementation.

Adopt these patterns:

- One visible state label at a time.
- GitHub comments and reviews as the human-readable audit trail.
- Separate reproduce/analyze, verify, fix, and post-fix verification contexts to reduce confirmation bias.
- Explicit early-exit outcomes such as clean, not actionable, unable to fix, and human needed.
- Project-owned skills for architecture, commands, tests, and fix constraints.
- Automation-owned state routing, GitHub integration, credentials, and model/tool protocol.
- Separate read and write authority.
- Per-PR concurrency and deterministic execution identities.
- Human confirmation for risky or uncertain changes.

Do not adopt Flue alongside Effect and Cloudflare Workflows unless the orchestration choice is deliberately revisited; it would overlap with both. Do not copy Astro's GitHub Actions runner or long-lived bot-token setup merely because the higher-level workflow is useful.

## GitHub identity decision

Use a GitHub App for production. Use a personal fine-grained PAT only for a short prototype.

Reasons:

- The automation appears as a distinct bot instead of as the user's personal account.
- The installation is independent of a person's continued repository or organization membership.
- Installation tokens are short-lived and can be restricted to the current repository and required permissions.
- GitHub Apps have centralized webhooks and installation-oriented rate limits.
- Audit history clearly distinguishes human and automated actions.

Start with one App and mint downscoped tokens per phase:

- Review: Contents read and Pull requests read.
- Publish review/labels: Pull requests write; add Issues write only if required by the chosen endpoints.
- Push a fix: Contents write, minted immediately before the push.
- Checks: Checks write only if check runs are used.

Persist the App ID, private key, webhook secret, and installation ID as appropriate. Do not persist installation access tokens in Workflow results, Artifacts, or the Sandbox. Tokens currently expire after one hour, so mint or refresh the write token immediately before a GitHub write rather than when a long agent run begins.

A stricter later design can split this into a read-only Reviewer App and a write-capable Fixer App.

For a same-repository PR, the App can update the branch when authorized. For a fork PR, the App may not be installed on or able to push to the contributor's fork. In that case, post suggested changes or create a fix branch and separate PR in the base repository. Do not use a personal account to bypass this ownership constraint.

## Open decisions

- Confirm Cloudflare Workflow + Sandbox rather than GitHub Actions as the execution platform.
- Select the AI provider and model used by the reviewer, fixer, and independent verifier.
- Decide whether low-risk fixes push automatically or require a maintainer-applied approval label.
- Decide the fork-PR behavior: suggestions, patch artifact, or separate PR.
- Finalize label names and permitted transitions.
- Decide where structured findings, large logs, and unfinished agent checkpoints live.
- Decide whether the first version needs a per-PR Durable Object coordinator.
- Confirm the Effect version and the package/module layout for Effect services used inside Workflow steps.
- Define which findings qualify for `autofix`, the maximum cycle count, and which paths or change types always require a human.

## Sources discussed

### Cloudflare

- [Cloudflare's Astro issue-triage article](https://blog.cloudflare.com/astro-issue-triage/)
- [Cloudflare Sandbox code-review bot](https://developers.cloudflare.com/sandbox/tutorials/code-review-bot/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Cloudflare Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
- [Cloudflare Sandbox command API](https://developers.cloudflare.com/sandbox/api/commands/)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Cloudflare Artifacts repository model](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- [Flue](https://flueframework.com/)

### Reference implementation

- [withastro/triagebot-action](https://github.com/withastro/triagebot-action)

### GitHub

- [Deciding when to build a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Pull-request reviews API](https://docs.github.com/en/rest/pulls/reviews)
- [Pull-request review comments API](https://docs.github.com/en/rest/pulls/comments)
- [Labels API](https://docs.github.com/en/rest/issues/labels)
- [Git references API](https://docs.github.com/en/rest/git/refs)

### Effect

- [Effect documentation](https://effect.website/docs/)
- [Effect unstable-module migration notes](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
- [Effect v3-to-v4 migration notes](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md)
