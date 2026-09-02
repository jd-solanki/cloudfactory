---
status: accepted
---

# Use Effect within Cloudflare Workflow steps

Use [Effect](https://www.effect.website/) for typed errors, services, dependency layers, retry policies, concurrency, and resource safety within GitHub Actions integration code and each Cloudflare Workflow step. Cloudflare Workflows remains the durability boundary, while Cloudflare Sandbox supplies the external Linux filesystem and processes used for repository work.

## Considered options

Using Effect as the durable workflow engine was rejected. Normal Effect fibers and local state disappear with their host invocation, and adopting Effect's unstable workflow module would require accepting an unstable API or maintaining the missing Cloudflare durability adapter.

Using Cloudflare Workflows without Effect was rejected because durability does not replace the application's need for explicit services, typed failure modes, validation, and resource scopes.

## Consequences

An Effect program may run inside a GitHub Action process or a Workflow step. Only versioned, serializable data crosses Workflow step boundaries; Effect fibers, scopes, layers, references, and Sandbox handles do not.

Effect retries handle short-lived failures within one active step. Cloudflare Workflow retries handle durable recovery. Each failure has one retry owner.
