# Tailgate Infrastructure

Pulumi infrastructure for protecting admin routes on a Vercel-hosted site via Tailscale.

## What This Does

```
Public Internet ──► Vercel (Next.js) ◄── X-Tailnet-Secret ── nginx ◄── Tailscale ◄── You
                         │
                         ▼
                    /admin blocked
                    unless header present
```

A GCP f1-micro VM runs Tailscale + nginx. When you access your site through `https://admin.yourtailnet.ts.net`, nginx proxies to Vercel and injects a secret header. Your Next.js middleware checks for this header to grant admin access.

## Project Structure

```
projects/
└── tailgate/       # The whole thing - GCP VM, Tailscale, Vercel env var

next-middleware/
└── middleware.ts   # Copy to your Next.js app
```

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- Node.js 18+
- `gcloud` CLI authenticated (`gcloud auth application-default login`)
- Tailscale account with API access
- Vercel project (already deployed, managed outside this repo)
- GCP project with Compute Engine API enabled

## Setup

```bash
cd projects/tailgate
pnpm install
pulumi stack init dev
```

### Configuration

```bash
# Required
pulumi config set vercelProjectName "your-vercel-project"
pulumi config set tailnetName "yourtailnet.ts.net"
pulumi config set gcp:project "your-gcp-project"
pulumi config set tailscale:tailnet "yourtailnet.ts.net"
pulumi config set --secret tailscale:apiKey "tskey-api-..."
pulumi config set --secret vercel:apiToken "your-vercel-token"

# Optional
pulumi config set hostname "admin"              # default: admin
pulumi config set zone "us-central1-a"          # default: us-central1-a
pulumi config set --secret tailnetSecret "..."  # default: auto-generated
```

### Tailscale ACLs

Add `tag:server` to your ACLs before deploying:

```json
{
  "tagOwners": {
    "tag:server": ["autogroup:admin"]
  },
  "acls": [
    {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:server:443"]}
  ]
}
```

## Deploy

```bash
pulumi up
```

## Add Middleware to Your Next.js App

Copy `next-middleware/middleware.ts` to your Next.js project root, or implement equivalent logic that checks for the `X-Tailnet-Secret` header on `/admin` routes.

## Usage

- **Public access**: `https://yourdomain.com` — works normally
- **Admin access**: `https://admin.yourtailnet.ts.net/admin` — works only from Tailscale

## Cost

All free tier:

| Service       | Tier        |
|---------------|-------------|
| GCP f1-micro  | Always Free |
| Tailscale     | Personal    |
| Pulumi        | Individual  |

## Troubleshooting

SSH into the VM:

```bash
gcloud compute ssh tailgate-dev --zone=us-central1-a
```

Check logs:

```bash
sudo cat /var/log/tailgate-setup.log
sudo tailscale status
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
```
