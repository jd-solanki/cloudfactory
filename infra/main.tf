# Credentials for the Code Factory review capability.
#
# This module owns secrets and nothing else. The Worker, its Workflow, the
# Durable Object migration, and the container image are deployed by Wrangler,
# because the Cloudflare Terraform provider cannot express a container
# application. See docs/adr/0004-terraform-provisioning.md.

resource "cloudflare_secrets_store" "cloudfactory" {
  account_id = var.account_id
  name       = var.store_name
}

resource "cloudflare_secrets_store_secret" "github_token" {
  account_id = var.account_id
  store_id   = cloudflare_secrets_store.cloudfactory.id
  name       = "github-token"
  scopes     = ["workers"]
  value      = var.github_token
  comment    = "Reads pull requests and publishes review comments."
}

resource "cloudflare_secrets_store_secret" "openai_api_key" {
  account_id = var.account_id
  store_id   = cloudflare_secrets_store.cloudfactory.id
  name       = "openai-api-key"
  scopes     = ["workers"]
  value      = var.openai_api_key
  comment    = "Attached to outbound model requests by the Worker."
}
