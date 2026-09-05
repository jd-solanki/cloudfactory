output "secrets_store_id" {
  description = "Put this in the store_id fields of apps/review-worker/wrangler.jsonc."
  value       = local.store_id
}

output "account_id" {
  description = "Set this as the CLOUDFLARE_ACCOUNT_ID secret in every reviewed repository."
  value       = var.account_id
}
