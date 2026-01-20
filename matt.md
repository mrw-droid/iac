# Matt's Setup Checklist

This document lists all the manual steps you need to complete before deploying the infrastructure.

## Prerequisites

### 1. Install Local Tools

```bash
# Pulumi CLI
curl -fsSL https://get.pulumi.com | sh

# Verify Node.js 18+
node --version

# gcloud CLI (if not installed)
# https://cloud.google.com/sdk/docs/install

# Authenticate gcloud
gcloud auth application-default login
```

### 2. Create a Pulumi Account

1. Go to https://app.pulumi.com/signup
2. Create an account (free tier works)
3. Run `pulumi login` to authenticate

---

## Secrets & Credentials to Gather

### MongoDB Atlas

1. **Create MongoDB Atlas Account** (if needed)
   - Go to https://www.mongodb.com/cloud/atlas/register

2. **Get Organization ID**
   - Log into Atlas
   - Click your organization name (top-left)
   - Go to **Settings**
   - Copy the **Organization ID**
   - Save as: `ATLAS_ORG_ID`

3. **Create API Keys**
   - Go to **Organization Access Manager** (left sidebar)
   - Click **API Keys** tab
   - Click **Create API Key**
   - Description: "Pulumi IaC"
   - Permissions: **Organization Project Creator**
   - Click **Next**
   - Copy and save:
     - `ATLAS_PUBLIC_KEY`
     - `ATLAS_PRIVATE_KEY`
   - Add your IP to the access list (or use 0.0.0.0/0 for anywhere)

4. **Create a Database Password**
   - Generate a strong password (no special chars recommended for connection strings)
   - Save as: `ATLAS_DB_PASSWORD`

---

### Vercel

1. **Create Vercel Account** (if needed)
   - Go to https://vercel.com/signup

2. **Get API Token**
   - Go to https://vercel.com/account/tokens
   - Click **Create**
   - Name: "Pulumi IaC"
   - Scope: Full Account
   - Expiration: No Expiration (or your preference)
   - Copy and save as: `VERCEL_API_TOKEN`

3. **Note Your GitHub Repo**
   - Format: `owner/repo` (e.g., `mrw-droid/my-website`)
   - Save as: `GITHUB_REPO`

---

### Google Cloud Platform (GCP)

1. **Create/Select GCP Project**
   - Go to https://console.cloud.google.com
   - Create a new project or select existing
   - Copy the **Project ID** (not the name)
   - Save as: `GCP_PROJECT_ID`

2. **Enable Required APIs**
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   gcloud services enable compute.googleapis.com
   ```

3. **Verify Billing**
   - Ensure billing is enabled for the project
   - f1-micro is free tier eligible in us-central1

4. **Authenticate**
   ```bash
   gcloud auth application-default login
   ```

---

### Tailscale

1. **Create Tailscale Account** (if needed)
   - Go to https://login.tailscale.com/start

2. **Get Your Tailnet Name**
   - Go to https://login.tailscale.com/admin/settings/general
   - Find your **Tailnet name** (e.g., `tail1234.ts.net` or custom like `myname.ts.net`)
   - Save as: `TAILNET_NAME`

3. **Create API Key**
   - Go to https://login.tailscale.com/admin/settings/keys
   - Scroll to **API Keys**
   - Click **Generate API key...**
   - Description: "Pulumi IaC"
   - Expiration: Your preference (90 days is reasonable, you can regenerate)
   - Copy and save as: `TAILSCALE_API_KEY`
   - Format: `tskey-api-...`

4. **Configure ACLs**
   - Go to https://login.tailscale.com/admin/acls
   - Add the `tag:server` tag owner:

   ```json
   {
     "tagOwners": {
       "tag:server": ["autogroup:admin"]
     },
     "acls": [
       // ... your existing ACLs ...
       {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:server:443"]}
     ]
   }
   ```

---

## Configuration Commands

Once you have all the credentials, run these commands in each project directory.

### Shared Project

```bash
cd projects/shared
npm install
pulumi stack init dev

# Optional: provide your own tailnet secret
# pulumi config set --secret tailnetSecret "your-64-char-secret"
```

### MongoDB Project

```bash
cd projects/mongodb
npm install
pulumi stack init dev

# Set configuration
pulumi config set atlasOrgId "YOUR_ATLAS_ORG_ID"
pulumi config set --secret atlasDbPassword "YOUR_ATLAS_DB_PASSWORD"
pulumi config set --secret mongodbatlas:publicKey "YOUR_ATLAS_PUBLIC_KEY"
pulumi config set --secret mongodbatlas:privateKey "YOUR_ATLAS_PRIVATE_KEY"
```

### Vercel Project

```bash
cd projects/vercel
npm install
pulumi stack init dev

# Set configuration
pulumi config set githubRepo "owner/repo"
pulumi config set --secret vercel:apiToken "YOUR_VERCEL_API_TOKEN"

# Optional: set custom domain
# pulumi config set domain "yourdomain.com"
```

### Tailgate Project

```bash
cd projects/tailgate
npm install
pulumi stack init dev

# Set configuration
pulumi config set tailnetName "YOUR_TAILNET_NAME"
pulumi config set gcp:project "YOUR_GCP_PROJECT_ID"
pulumi config set gcp:region "us-central1"
pulumi config set tailscale:tailnet "YOUR_TAILNET_NAME"
pulumi config set --secret tailscale:apiKey "YOUR_TAILSCALE_API_KEY"
```

---

## Deployment Order

Deploy in this order (dependencies flow downstream):

```bash
# 1. Shared (generates tailnet secret)
cd projects/shared && pulumi up

# 2. MongoDB (standalone)
cd projects/mongodb && pulumi up

# 3. Vercel (depends on shared + mongodb)
cd projects/vercel && pulumi up

# 4. Tailgate (depends on shared + vercel)
cd projects/tailgate && pulumi up
```

---

## Post-Deployment Steps

### 1. Configure DNS (if using custom domain)

Add these DNS records to your domain:

| Type  | Name | Value                |
|-------|------|----------------------|
| CNAME | @    | cname.vercel-dns.com |
| CNAME | www  | cname.vercel-dns.com |

### 2. Add Middleware to Your Next.js App

Copy the middleware file to your website repo:

```bash
cp next-middleware/middleware.ts /path/to/your/nextjs-app/middleware.ts
```

### 3. Verify Everything Works

```bash
# Public access works
curl https://yourdomain.com

# Admin is blocked publicly (should return 404)
curl https://yourdomain.com/admin

# Admin works via Tailnet (from a device on your tailnet)
curl https://admin.YOUR_TAILNET.ts.net/admin
```

---

## Summary of Secrets to Gather

| Secret               | Source                          | Used In       |
|----------------------|---------------------------------|---------------|
| `ATLAS_ORG_ID`       | Atlas Organization Settings     | mongodb       |
| `ATLAS_PUBLIC_KEY`   | Atlas API Keys                  | mongodb       |
| `ATLAS_PRIVATE_KEY`  | Atlas API Keys                  | mongodb       |
| `ATLAS_DB_PASSWORD`  | You create this                 | mongodb       |
| `VERCEL_API_TOKEN`   | Vercel Account Tokens           | vercel        |
| `GITHUB_REPO`        | Your GitHub repo                | vercel        |
| `GCP_PROJECT_ID`     | GCP Console                     | tailgate      |
| `TAILNET_NAME`       | Tailscale Admin Settings        | tailgate      |
| `TAILSCALE_API_KEY`  | Tailscale Admin Keys            | tailgate      |
