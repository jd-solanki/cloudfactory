---
status: accepted
---

# Distribute as a reusable workflow with user-hosted infrastructure

The Code Factory is an open-source project that each user deploys into their own Cloudflare account. Users reference a versioned reusable GitHub workflow published from this repository and supply their own Cloudflare account, model credentials, and GitHub token. The project operates no shared service and holds no user credentials or user code.

A Run starts when a maintainer applies the `agent:review` label. The reusable workflow forwards the repository coordinates and head SHA to the user's own Cloudflare Workflow endpoint and then exits.

## Considered options

A hosted multi-tenant service was rejected. It requires a public ingress to defend, per-installation credential custody, quota enforcement, and billing before the first capability has been proven in use.

Forking this repository was rejected. A fork cannot receive upstream changes without merge work, so every user's deployment drifts away from the published capability.

A public HTTP Worker as the event boundary was reconsidered and again rejected, so [ADR 0001](0001-github-actions-cloudflare-workflows.md) stands. Because the user hosts the deployment, GitHub Actions remains the authenticated, repository-aware entry point and no ingress is exposed to the internet.

## Consequences

The reusable workflow is a public interface. Its inputs and secret names are versioned by tag. A breaking change requires a new major tag; users move by changing the tag they reference. No compatibility shim is added inside the workflow.

Model and compute costs belong to the user who deployed the capability. The project therefore enforces no quotas.

Applying a label requires write access to the repository, so only trusted people can start a Run. The reusable workflow forwards coordinates only and never checks out pull-request code, so `pull_request_target` exposes no secret to code from a fork.

Model and repository credentials are provisioned as Cloudflare Worker secrets. They are never passed as Workflow inputs, because Workflow inputs are durable state.
