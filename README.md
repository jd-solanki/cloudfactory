# Code Factory

The Code Factory reviews pull requests. It checks out the exact head revision
in an isolated sandbox, reviews the change with a coding agent, and posts the
result as one comment.

You run it in your own Cloudflare account. This project operates no service and
holds none of your credentials or code.

## How a review starts

A maintainer applies the `agent:review` label to a pull request. Applying a
label needs write access, so only trusted people can start a Run.

```text
label applied
  -> GitHub Actions forwards the repository, pull request, and head SHA
     -> Cloudflare Workflow
        -> sandbox: check out the head SHA, review it, publish the comment
```

GitHub Actions never checks out pull-request code. It forwards four fields and
exits.

## Install

You need a Cloudflare account with Workers and Containers enabled, Docker
running locally, and an OpenAI API key.

### 1. Create the secrets

The Terraform module in [`infra/`](infra/) creates a Cloudflare Secrets Store
and puts both credentials in it.

```bash
cd infra
terraform init
terraform apply
```

Terraform asks for each value it needs, so nothing lands on disk or in your
shell history:

| Prompt           | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `api_token`      | Cloudflare token with `Secrets Store Read` and `Secrets Store Write` |
| `account_id`     | The Cloudflare account to deploy into                                |
| `github_token`   | Fine-grained token with `Pull requests: Read and write`              |
| `openai_api_key` | Your model credential                                                |

To stop retyping them, put the same names in `infra/terraform.tfvars`. That file
is gitignored. [`infra/variables.tf`](infra/variables.tf) describes each one.

Keep the `secrets_store_id` output.

### 2. Deploy the Worker

Terraform cannot deploy this Worker. The Cloudflare provider's `containers`
attribute accepts only a Durable Object class name, so it can neither build nor
push a container image. Wrangler does that step, and it owns nothing Terraform
owns. See [ADR 0004](docs/adr/0004-terraform-provisioning.md).

Put the `secrets_store_id` from step 1 into both `store_id` fields of
`apps/review-worker/wrangler.jsonc`, then:

```bash
pnpm install
pnpm -C apps/review-worker exec wrangler deploy
```

This builds the container image, pushes it, and creates the Worker, the
Workflow, and the Durable Object.

### 3. Turn it on for a repository

Steps 1 and 2 happen once for your whole account. This step repeats for each
repository you want reviewed.

```bash
# --token needs account-scoped Workers Scripts: Write.
# --account is the account_id output from step 1.
./scripts/enable-repo.sh --token cf_xxx --account 1a2b3c octocorp/app
```

The script creates the `agent:review` label, sets both repository secrets, and
commits the workflow file. Running it again on the same repository is safe.

A token on the command line is visible to other processes and lands in your
shell history. Use a throwaway token, or prefix the command with a space where
your shell skips those.

Open a pull request, apply the `agent:review` label, and the review appears as a
comment.

To do it by hand instead: add those two secrets, create the label, and commit
this file.

```yaml
# .github/workflows/agent-review.yml
on:
  pull_request_target:
    types: [labeled]

jobs:
  review:
    uses: jd-solanki/cloudfactory/.github/workflows/review.yml@v1
    secrets: inherit
```

## Many projects

One deployment serves every repository. Nothing in the Worker is tied to a
single project, so steps 1 and 2 never repeat.

```bash
./scripts/enable-repo.sh --token cf_xxx --account 1a2b3c \
  john/dotfiles john/personal-website octocorp/app
```

### The GitHub token must cover all of them

It is one fine-grained token, set in step 1. Select every repository you want
reviewed, and only those.

### Secrets can live at the organization level

If your projects sit in a GitHub organization, set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` once as organization secrets. The script then has
nothing to set per repository.

### Five reviews run at once

`max_instances` in `apps/review-worker/wrangler.jsonc` caps concurrent
containers across every project. The sixth review waits for a free slot.

## API tokens

You need two Cloudflare tokens, with different permissions.

| Used by                   | Permissions                                 |
| ------------------------- | ------------------------------------------- |
| Terraform, in step 1      | `Secrets Store Read`, `Secrets Store Write` |
| GitHub Actions, in step 3 | `Workers Scripts: Write`                    |

The GitHub token in step 1 needs `Pull requests: Read and write` on every
repository under review.

## Configure the review

A reviewed repository owns its own review rules in `.code-factory/review.md`.
The sandbox reads that file from the checkout. A repository without the file
gets the default instructions in
[`packages/core/src/review-instructions.ts`](packages/core/src/review-instructions.ts).

## Where credentials live

The review container holds no credential.

| Credential           | Held by                        | Never reaches             |
| -------------------- | ------------------------------ | ------------------------- |
| Cloudflare API token | GitHub Actions                 | the Worker, the container |
| GitHub token         | the Worker, from Secrets Store | the container             |
| Model API key        | the Worker, from Secrets Store | the container             |

The Worker fetches the repository and streams it into the sandbox, so the
sandbox never talks to GitHub. The reviewing agent sends model requests with no
credential, and the Worker attaches one after the request leaves the container.
The container can reach exactly one host and is destroyed when the Run ends.

One exception sits outside that boundary. Terraform records what it created, so
your GitHub token and model key end up in `infra/terraform.tfstate` in
plaintext. That file is gitignored. Treat it as a secret, or move the module to
a remote backend that encrypts state. The Cloudflare API token is not affected;
it configures the provider rather than a resource, so it never enters state.

## Layout

```text
.github/workflows/review.yml   the reusable workflow other repositories call
infra/                         Terraform module for secrets
scripts/enable-repo.sh         turns on reviews for one repository
packages/core/                 capability logic, no Cloudflare imports
apps/review-worker/            Worker, Workflow, and sandbox
docs/                          decisions, capability specification, research
```

## Development

```bash
pnpm run ready   # format, lint, typecheck, test, build
```
