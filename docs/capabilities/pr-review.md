# PR review capability

The PR review capability inspects one pull-request head, verifies its findings, fixes work that is safe and actionable, and reviews the resulting revision. It is the first capability of the Code Factory, not the boundary of the product.

## Execution shape

```text
GitHub pull-request event
    -> GitHub Actions
        -> start deterministic Cloudflare Workflow instance
            -> check out the exact head SHA in Cloudflare Sandbox
            -> reviewer context
            -> verifier context
            -> optional fixer context
            -> fresh reviewer and verifier contexts
        -> GitHub review, check run, label, or commit
```

GitHub Actions finishes after Cloudflare accepts the Workflow instance. The Workflow may continue for 30 minutes or longer.

The Workflow coordinates durable steps and owns the control flow. Sandbox provides the isolated checkout, filesystem, and commands. The AI model requests narrowly defined repository tools rather than receiving repository credentials.

## Review contract

Every review produces a structured decision tied to the reviewed head SHA before rendering GitHub prose:

```ts
type ReviewDecision =
  | { verdict: "clean"; headSha: string; findings: [] }
  | { verdict: "autofix"; headSha: string; findings: ActionableFinding[] }
  | { verdict: "human"; headSha: string; findings: Finding[]; reason: string };
```

A comment or review is an audit record, not a control signal. Only a trusted `autofix` decision for the current head SHA can request a fix.

PR reviews, bot comments, the repository at the expected revision, and the trusted structured decision provide enough context for a new stage to reconstruct the work. Reviewer, verifier, fixer, and re-review stages use separate model contexts to reduce confirmation bias.

## Review loop

```text
analyze -> verify finding -> fix -> re-review
```

- The reviewer identifies possible findings.
- The verifier independently establishes whether each finding is real, actionable, and safe to automate.
- The fixer receives only verified actionable findings and starts from the exact reviewed SHA.
- The fixer creates a commit and triggers the repository's CI or check run.
- The resulting head SHA is reviewed by fresh reviewer and verifier contexts.
- The loop finishes when re-review succeeds or maintainer approves.
- Conflicts, unsafe changes, uncertainty, or the attempt limit require a human.

## Label state machine

Keep exactly one `agent:*` state label on each pull request and preserve every unrelated label.

| Current state      | Event                                     | Next state           | Effect                                        |
| ------------------ | ----------------------------------------- | -------------------- | --------------------------------------------- |
| none               | PR opened or becomes ready                | `agent:reviewing`    | Start review Workflow                         |
| any active state   | New head SHA                              | `agent:reviewing`    | Supersede stale work and review the new SHA   |
| `agent:reviewing`  | No actionable findings                    | `agent:clean`        | Stop                                          |
| `agent:reviewing`  | Safe, actionable findings                 | `agent:fix-needed`   | Start fix Workflow                            |
| `agent:reviewing`  | Human judgment required                   | `agent:human-needed` | Stop and notify                               |
| `agent:fix-needed` | Fix Workflow claims work                  | `agent:fixing`       | Start Sandbox agent                           |
| `agent:fixing`     | Agent pushes commit                       | `agent:reviewing`    | The `synchronize` event starts a fresh review |
| `agent:fixing`     | Conflict, unsafe change, or attempt limit | `agent:human-needed` | Stop and notify                               |
| any active state   | Infrastructure failure                    | `agent:failed`       | Permit explicit retry                         |
| any                | PR closed or merged                       | no state label       | Terminate active Workflows                    |

Labels are a human-visible projection. Workflow state and validated structured decisions remain authoritative.

## Invariants

- A new head SHA supersedes every unfinished review or fix for the previous SHA.
- Repository-changing stages re-fetch the head SHA immediately before publishing and never force-push over newer work.
- “Nothing to fix” is a successful terminal result and never starts a fixer.
- Automated fix and re-review cycles are bounded.
- GitHub writes are idempotent and safe under event redelivery and Workflow retry.
- Read-only stages cannot silently gain write authority.
- Credentials never appear in model context, Workflow results, artifacts, logs, or the Sandbox beyond their intended phase.
- A fresh Sandbox is created for each attempt. A live Sandbox is not durable state.
- Repository-owned review and fix instructions define project-specific commands, architecture rules, tests, and change constraints.
- Structured control data is versioned and validated before it affects routing.

## References

- [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Cloudflare Workflow triggers](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Cloudflare Sandbox code-review bot](https://developers.cloudflare.com/sandbox/tutorials/code-review-bot/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
- [withastro/triagebot-action](https://github.com/withastro/triagebot-action)
- [Effect documentation](https://effect.website/docs/)
