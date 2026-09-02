---
status: accepted
---

# Trigger Cloudflare Workflows from GitHub Actions

GitHub Actions receives repository events, normalizes them, applies the initial policy gate, and starts a deterministic Cloudflare Workflow instance through Cloudflare's external API. The Action exits after the instance is accepted; Cloudflare Workflows owns durable orchestration, and Cloudflare Sandbox provides an isolated repository checkout and tool environment when required.

## Considered options

A public HTTP Worker was rejected because GitHub Actions already provides an authenticated, repository-aware event boundary. Keeping both would add another deployed ingress service without adding orchestration value.

Running the complete agent inside GitHub Actions was rejected because runs can exceed 30 minutes and may need durable retries, waits, and resumability independent of a GitHub runner.

## Consequences

The Action passes a versioned, normalized request rather than exposing raw GitHub payloads to the core workflow. Event redelivery is expected, so Workflow instance identities and all externally visible writes must be deterministic or idempotent.

Cloudflare authentication is required in GitHub Actions. The initial credential mechanism remains an implementation decision.
