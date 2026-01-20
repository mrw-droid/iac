# Personal Website Infrastructure

Pulumi infrastructure for deploying a personal website with:

- **Vercel** — Next.js hosting
- **MongoDB Atlas** — Database (free M0 tier)
- **Tailgate** — GCP f1-micro VM running Tailscale + nginx to protect `/admin` routes

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Public Internet                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                │                                          │
                │ Public traffic                           │ Admin traffic
                │ (yourdomain.com)                         │ (via Tailnet)
                ▼                                          ▼
┌──────────────────────────┐                 ┌──────────────────────────┐
│         Vercel           │                 │      Your Device         │
│   ┌──────────────────┐   │                 │   (on Tailscale)         │
│   │   Next.js App    │   │                 └──────────────────────────┘
│   │                  │   │                               │
│   │   Middleware     │   │                               │
│   │   checks for     │◄──┼───────────────────────────────┘
│   │   X-Tailnet-     │   │         admin.tailnet.ts.net
│   │   Secret header  │   │                   │
│   └──────────────────┘   │                   ▼
└──────────────────────────┘     ┌──────────────────────────┐
                │                │   Tailgate (f1-micro)    │
                │                │   ┌──────────────────┐   │
                ▼                │   │     nginx        │   │
┌──────────────────────────┐     │   │  adds header:    │   │
│     MongoDB Atlas        │     │   │  X-Tailnet-      │   │
│     (M0 Free Tier)       │     │   │  Secret          │   │
└──────────────────────────┘     │   └──────────────────┘   │
                                 │   ┌──────────────────┐   │
                                 │   │    Tailscale     │   │
                                 │   └──────────────────┘   │
                                 └──────────────────────────┘
```

## Prerequisites

### Accounts & Access

1. **Pulumi** — Account at [pulumi.com](https://pulumi.com) (free tier works)
1. **Vercel** — Account with API token
1. **MongoDB Atlas** — Account with organization created
1. **GCP** — Project with billing enabled (f1-micro is free tier eligible)
1. **Tailscale** — Account with admin API access
1. **GitHub** — Repository for your website code

### Local Tools

```bash
# Pulumi CLI
curl -fsSL https://get.pulumi.com | sh

# Node.js 18+
node --version

# gcloud CLI (for GCP auth)
gcloud auth application-default login
```

## Setup

### 1. Clone and Install

```bash
cd infrastructure
npm install
```

### 2. Create Stack Configuration

```bash
# Copy the template
cp Pulumi.dev.yaml.template Pulumi.dev.yaml

# Edit with your values
vim Pulumi.dev.yaml
```

### 3. Set Secrets

```bash
# Vercel API token (Settings → Tokens)
pulumi config set --secret vercelApiToken "your-vercel-token"

# MongoDB Atlas API keys (Organization → Access Manager → API Keys)
pulumi config set --secret atlasPublicKey "your-atlas-public-key"
pulumi config set --secret atlasPrivateKey "your-atlas-private-key"
pulumi config set --secret atlasDbPassword "a-strong-password"

# Tailscale API key (Settings → Keys → API Keys)
pulumi config set --secret tailscaleApiKey "tskey-api-..."

# Optional: provide your own tailnet secret (otherwise one is generated)
# pulumi config set --secret tailnetSecret "your-64-char-secret"
```

### 4. Configure Tailscale ACLs

Before deploying, add the `tag:server` tag to your Tailscale ACLs:

```json
{
  "tagOwners": {
    "tag:server": ["autogroup:admin"]
  },
  "acls": [
    // ... your existing ACLs
    {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:server:443"]}
  ]
}
```

### 5. Deploy

```bash
# Preview changes
pulumi preview

# Deploy
pulumi up
```

### 6. Add Middleware to Your Next.js App

Copy `next-middleware/middleware.ts` to the root of your Next.js project:

```bash
cp next-middleware/middleware.ts /path/to/your/nextjs/app/middleware.ts
```

### 7. Configure DNS

After deployment, Pulumi will output the Vercel domains. Add DNS records:

|Type |Name|Value               |
|-----|----|--------------------|
|CNAME|@   |cname.vercel-dns.com|
|CNAME|www |cname.vercel-dns.com|

Or use Vercel’s nameservers for full DNS management.

### 8. Verify

```bash
# Public access works
curl https://yourdomain.com

# Admin is blocked publicly
curl https://yourdomain.com/admin  # Should return 404

# Admin works via Tailnet
# (from a device on your tailnet)
curl https://admin.yourtailnet.ts.net/admin  # Should work!
```

## Usage

### Accessing Admin

1. Ensure you’re connected to Tailscale
1. Navigate to `https://admin.yourtailnet.ts.net/admin`
1. The Tailgate proxy adds the secret header automatically
1. You’re in!

### Updating Infrastructure

```bash
# Make changes to the Pulumi code, then:
pulumi up
```

### Viewing Outputs

```bash
pulumi stack output
```

### Destroying Everything

```bash
pulumi destroy
```

## Troubleshooting

### Tailgate VM not joining Tailscale

SSH into the VM and check logs:

```bash
gcloud compute ssh tailgate --zone=us-central1-a
sudo cat /var/log/tailgate-setup.log
sudo tailscale status
```

### Certificate issues

The startup script runs `tailscale cert`. If it fails:

```bash
# SSH into the VM
sudo tailscale cert --cert-file /etc/tailscale-certs/cert.pem \
  --key-file /etc/tailscale-certs/key.pem \
  admin.yourtailnet.ts.net
```

### Nginx not proxying correctly

```bash
# Check nginx status
sudo systemctl status nginx
sudo nginx -t

# Check the config
cat /etc/nginx/sites-available/tailgate

# Check logs
sudo tail -f /var/log/nginx/error.log
```

### Admin still accessible publicly

1. Verify `TAILNET_SECRET` is set in Vercel environment variables
1. Check that the middleware is in the right location (`middleware.ts` at project root)
1. Verify the middleware matcher includes `/admin/:path*`

## File Structure

```
infrastructure/
├── Pulumi.yaml                 # Project definition
├── Pulumi.dev.yaml.template    # Stack config template
├── package.json
├── tsconfig.json
├── index.ts                    # Main entry point
├── components/
│   ├── mongodb.ts              # MongoDB Atlas resources
│   ├── vercel.ts               # Vercel project & domains
│   ├── tailgate.ts             # GCP VM + Tailscale + nginx
│   └── secrets.ts              # Secret generation
└── next-middleware/
    └── middleware.ts           # Copy this to your Next.js app
```

## Cost

Everything here is within free tier limits:

|Service      |Tier       |Limit                           |
|-------------|-----------|--------------------------------|
|Vercel       |Hobby      |100GB bandwidth, 100 build hours|
|MongoDB Atlas|M0         |512MB storage, shared cluster   |
|GCP f1-micro |Always Free|1 instance in select regions    |
|Tailscale    |Personal   |100 devices                     |
|Pulumi       |Individual |200 resources                   |

## Security Notes

1. **The tailnet secret** is the only thing protecting `/admin`. It’s stored encrypted in:
- Pulumi state (encrypted)
- Vercel environment variables (encrypted)
- The f1-micro’s nginx config (on disk)
1. **MongoDB allows connections from anywhere** (`0.0.0.0/0`) because Vercel’s IPs are dynamic. The connection is authenticated and encrypted (TLS).
1. **The f1-micro has an external IP** initially for setup. After Tailscale is running, you could remove it, but it’s needed for system updates.
1. **The auth key expires** after 1 hour. It’s only used during initial VM setup. If you need to recreate the VM, you’ll need to generate a new key (Pulumi handles this).

## Future Improvements

- [ ] Add monitoring/alerting for the Tailgate VM
- [ ] Set up automatic backups for MongoDB
- [ ] Add a staging environment
- [ ] Implement IP allowlisting for MongoDB (if Vercel IPs become static)
