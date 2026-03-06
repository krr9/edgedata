# EdgeData Terraform Bootstrap

Minimal Terraform bootstrap for EdgeData core data infrastructure.

Provisioned resources:

- `cloudflare_r2_bucket` for raw/event/token objects
- `cloudflare_d1_database` for auth/saved-search/alerts state

## Usage

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with real account/token values
terraform init
terraform plan
terraform apply
```

After apply, run schema migrations from repo root:

```bash
npm run d1:migrate
npm run d1:migrate:authz
npm run d1:migrate:users
npm run d1:migrate:ratelimits
```

Notes:

- Worker/Pages code deploys remain managed by Wrangler (`npm run deploy:*`).
- This module intentionally avoids deploying scripts to prevent Terraform/Wrangler ownership conflicts.
