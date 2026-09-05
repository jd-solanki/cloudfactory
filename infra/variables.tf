variable "api_token" {
  description = <<-EOT
    Cloudflare API token this module authenticates with.
    Needs Secrets Store Read and Secrets Store Write.
  EOT
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account that hosts the review Worker."
  type        = string
}

variable "store_name" {
  description = <<-EOT
    Name for the Secrets Store, used only when the account has none yet.
    An account that already has a store keeps it, whatever it is called.
  EOT
  type        = string
  default     = "cloudfactory"
}

variable "github_token" {
  description = <<-EOT
    Token the Worker uses to read the pull request and publish the review.
    Needs Pull requests: Read and write on every repository under review.
  EOT
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = <<-EOT
    Model credential. The Worker attaches it to outbound requests, so it never
    exists inside the review container.
  EOT
  type        = string
  sensitive   = true
}
