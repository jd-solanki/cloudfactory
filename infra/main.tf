# Credentials for the Code Factory review capability.
#
# This module owns secrets and nothing else. The Worker, its Workflow, the
# Durable Object migration, and the container image are deployed by Wrangler,
# because the Cloudflare Terraform provider cannot express a container
# application. See docs/adr/0004-terraform-provisioning.md.

data "cloudflare_secrets_stores" "account" {
  account_id = var.account_id
}

locals {
  # Cloudflare allows one Secrets Store per account, and rejects a second with
  # maximum_stores_exceeded. Most accounts already have one, so reuse it.
  stores         = data.cloudflare_secrets_stores.account.result
  existing_store = length(local.stores) > 0 ? local.stores[0] : null
}

resource "cloudflare_secrets_store" "cloudfactory" {
  count = local.existing_store == null ? 1 : 0

  account_id = var.account_id
  name       = var.store_name
}

locals {
  store_id = local.existing_store != null ? local.existing_store.id : cloudflare_secrets_store.cloudfactory[0].id
}

resource "cloudflare_secrets_store_secret" "github_token" {
  account_id = var.account_id
  store_id   = local.store_id
  name       = "github-token"
  scopes     = ["workers"]
  value      = var.github_token
  comment    = "Reads pull requests and publishes review comments."
}

resource "cloudflare_secrets_store_secret" "openai_api_key" {
  account_id = var.account_id
  store_id   = local.store_id
  name       = "openai-api-key"
  scopes     = ["workers"]
  value      = var.openai_api_key
  comment    = "Attached to outbound model requests by the Worker."
}
