# Personal Website Infrastructure

Pulumi infrastructure for deploying a personal website with:

- **Vercel** - Next.js hosting
- **MongoDB Atlas** - Database (free M0 tier)
- **Tailgate** - GCP f1-micro VM running Tailscale + nginx to protect `/admin` routes

## Project Structure

This infrastructure is split into four separate Pulumi projects to keep each manageable:

```
projects/
├── shared/     # Shared secrets (tailnet secret)
├── mongodb/    # MongoDB Atlas cluster and database
├── vercel/     # Vercel project and domains
└── tailgate/   # GCP VM with Tailscale + nginx proxy

next-middleware/
└── middleware.ts   # Copy this to your Next.js app
```

## Getting Started

1. Read `matt.md` for the complete setup checklist
2. Gather all required credentials and secrets
3. Deploy projects in order: shared → mongodb → vercel → tailgate

## Architecture

See `docs/overview.md` for the full architecture diagram and detailed documentation.

## Deployment Order

The projects have dependencies and must be deployed in this order:

1. **shared** - Generates the tailnet secret
2. **mongodb** - Creates the Atlas cluster (standalone)
3. **vercel** - Creates Vercel project (uses shared + mongodb outputs)
4. **tailgate** - Creates GCP VM (uses shared + vercel outputs)

```bash
cd projects/shared && pulumi up
cd projects/mongodb && pulumi up
cd projects/vercel && pulumi up
cd projects/tailgate && pulumi up
```

## Cost

Everything stays within free tier limits:

| Service       | Tier        | Limit                            |
|---------------|-------------|----------------------------------|
| Vercel        | Hobby       | 100GB bandwidth, 100 build hours |
| MongoDB Atlas | M0          | 512MB storage, shared cluster    |
| GCP f1-micro  | Always Free | 1 instance in us-central1        |
| Tailscale     | Personal    | 100 devices                      |
| Pulumi        | Individual  | 200 resources                    |
