terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.15.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_r2_bucket" "raw" {
  account_id = var.account_id
  name       = var.raw_bucket_name
}

resource "cloudflare_d1_database" "edgedata" {
  account_id = var.account_id
  name       = var.d1_database_name
}
