variable "cloudflare_api_token" {
  description = "Cloudflare API token with account permissions for R2 and D1."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "raw_bucket_name" {
  description = "R2 bucket for EdgeData raw/events/tokens objects."
  type        = string
  default     = "edgedata-raw"
}

variable "d1_database_name" {
  description = "D1 database name for EdgeData metadata tables."
  type        = string
  default     = "edgedata-db"
}
