# PR review capability: Working handoff

Last updated: 2026-09-02

## Goal

Agree and implement the first end-to-end PR review capability of the Code Factory.

## Current status

The documentation model and high-level architecture are agreed. No application implementation has started.

Settled decisions and PR-review behavior have been promoted to durable documents. This handoff now tracks only the choices and work that remain open.

## Decisions

No accepted decisions are waiting to be promoted. The phrase “re-review succeeds or maintainer approves” is intentionally retained without defining the approval mechanism yet.

## Constraints and invariants

No handoff-only invariants are currently known. The stable constraints live in the PR review capability document and accepted ADRs linked below.

## Evidence and sources

- [`CONTEXT.md`](../CONTEXT.md) defines Code Factory, Capability, Work Item, and Run.
- [`docs/adr/0001-github-actions-cloudflare-workflows.md`](adr/0001-github-actions-cloudflare-workflows.md) records the trigger and durability boundary.
- [`docs/adr/0002-effect-application-runtime.md`](adr/0002-effect-application-runtime.md) records the Effect and Cloudflare Workflows boundary.
- [`docs/capabilities/pr-review.md`](capabilities/pr-review.md) is the source of truth for the approved PR-review behavior, including the screenshot material.

## Workspace changes

- Promoted settled architecture into two accepted ADRs.
- Added the stable PR review capability specification.
- Replaced the accumulated architecture handoff with this unresolved-state snapshot.
- No application code has been written.

## Verification

- Documentation paths and relative links were checked locally.
- Markdown whitespace validation passed.
- No application tests were run because only documentation changed.

## Open questions

- Where does the trusted structured `ReviewDecision` live so a separate fix Workflow can retrieve it safely?
- What exact GitHub mechanism implements “maintainer approves”?
- Which AI provider and model perform review, verification, and fixing?
- Does the first implementation use the stable Cloudflare Sandbox package or the Sandbox 1.0 preview?
- How does GitHub Actions authenticate to Cloudflare: a least-privilege API token initially, or short-lived federation?
- What is the first vertical slice: trigger-to-stub-result, or a complete read-only review with model output?

## Next action

Approve the first implementation slice and resolve only the choices required to build it; defer fixer and maintainer-approval mechanics until the read-only review path works end to end.
