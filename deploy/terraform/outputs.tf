output "raw_bucket_name" {
  description = "Provisioned R2 bucket name."
  value       = cloudflare_r2_bucket.raw.name
}

output "d1_database_id" {
  description = "Provisioned D1 database ID."
  value       = cloudflare_d1_database.edgedata.id
}

output "d1_database_name" {
  description = "Provisioned D1 database name."
  value       = cloudflare_d1_database.edgedata.name
}
