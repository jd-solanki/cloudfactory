---
status: accepted
---

# Provision Cloudflare resources with Terraform where the provider allows it

Terraform is the supported way to create every Cloudflare resource the Code
Factory can express as one. The repository ships a Terraform module in `infra/`.

The Cloudflare Terraform provider cannot express a container application. Its
`cloudflare_worker_version.containers` attribute accepts a single field,
`class_name`, so it can neither build an image, push one, nor set an instance
type or instance cap. A Worker that owns a container therefore cannot be
deployed from Terraform at all.

The boundary that follows is drawn so that no resource has two owners:

| Owner     | Resources                                                                   |
| --------- | --------------------------------------------------------------------------- |
| Terraform | Secrets Store, and the secrets in it                                        |
| Wrangler  | Worker, Workflow, Durable Object migration, container image and application |

The README documents the Wrangler step with its exact commands and settings.

## Considered options

A Wrangler-only setup was rejected as the supported path for everything.
Wrangler deploys code; it does not describe infrastructure, hold state, or
reveal drift. Credentials in particular need a lifecycle Terraform can audit.

Waiting for provider parity before releasing was rejected. Cloudflare Workflows
and Containers are recent, provider coverage moves independently of this
project, and the capability cannot ship on that schedule.

Generating a Wrangler configuration from Terraform outputs was rejected. It adds
a build step and a generated file in order to avoid copying one identifier once.

## Consequences

Setup is two commands in a fixed order, and the README states that order. A user
reads the module to learn exactly what the Code Factory creates in their
account, and reads `apps/review-worker/wrangler.jsonc` to learn what Wrangler
creates.

The Secrets Store identifier is a Terraform output and a Wrangler input. It is
copied by hand once, at install time. It is not a secret.

Two Cloudflare API tokens are needed, with different permissions: Secrets Store
Read and Write for Terraform, and account-scoped Workers Scripts Write for the
GitHub Action that starts a Run. Each token's permission set is documented where
it is used.

When the provider gains a container application resource, the Worker moves into
the module and the Wrangler step leaves the README.

## References

- [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [`cloudflare_worker_version`](https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/docs/resources/worker_version.md)
