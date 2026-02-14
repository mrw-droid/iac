# Sark Infrastructure

> *"I'm Sark. I work for the MCP."*

MCP gateway + Foundry VTT server on GCP, fronted by Caddy with Google OAuth.

## Architecture

```
Internet
    │
    ▼
sark.flatline.ai (Caddy + Google OAuth)
    ├── /k8s  ──► kubernetes-mcp-server (via tailnet)
    ├── /vtt  ──► foundry-vtt-mcp (via tailnet) [future]
    └── /*    ──► status page
    
foundry.flatline.ai (Caddy, no OAuth)
    └── ──► Foundry VTT (localhost:30000)

All on a single GCP n2d-standard-4 VM running Debian 13 (Trixie).
Tailscale connects to the homelab tailnet for MCP backend access.
```

## Prerequisites

- Pulumi CLI installed and logged in
- GCP CLI (`gcloud`) authenticated with access to `foundry-487415`
- A Tailscale auth key (create at https://login.tailscale.com/admin/settings/keys)
- A Foundry VTT license key and download URL
- Google OAuth credentials (see below)

## Step 1: Create Google OAuth Credentials

This is the one thing that can't be fully automated. It takes ~5 minutes.

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=foundry-487415)

2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**

3. If prompted, configure the **OAuth consent screen** first:
   - User Type: **External**
   - App name: `Sark MCP Gateway`
   - User support email: your email
   - Developer contact: your email
   - Scopes: add `email`, `profile`, `openid`
   - **Test users**: add your Google email address
   - **DO NOT publish the app** — leave it in "Testing" mode
   
   > This is the key trick: in testing mode, only the whitelisted
   > email addresses can authenticate. Max 100 test users, and you
   > only need one.

4. Back to Credentials → Create OAuth client ID:
   - Application type: **Web application**
   - Name: `Sark MCP Gateway`
   - Authorized redirect URIs:
     - `https://sark.flatline.ai/oauth2/google/authorization-code-callback`
   - Click **Create**

5. Copy the **Client ID** and **Client Secret**

## Step 2: Configure Pulumi Secrets

```bash
cd sark-infra
pulumi stack init prod

# Google OAuth (from step 1)
pulumi config set --secret sark-infra:googleOauthClientId "YOUR_CLIENT_ID.apps.googleusercontent.com"
pulumi config set --secret sark-infra:googleOauthClientSecret "GOCSPX-YOUR_SECRET"

# Your Google email (the one whitelisted in OAuth test mode)
pulumi config set --secret sark-infra:authorizedEmail "you@gmail.com"

# Foundry VTT
pulumi config set --secret sark-infra:foundryLicenseKey "YOUR-FVTT-LICENSE-KEY"
# Get this URL from https://foundryvtt.com/me/licenses → your license → Linux/NodeJS download link
pulumi config set --secret sark-infra:foundryDownloadUrl "https://foundryvtt.com/releases/..."

# Tailscale auth key (ephemeral, reusable recommended)
pulumi config set --secret sark-infra:tailscaleAuthKey "tskey-auth-XXXXX"

# The k8s MCP server endpoint on the tailnet
# This is where containers/kubernetes-mcp-server is running
# e.g., the tailnet IP of your k8s control plane node + port
pulumi config set sark-infra:k8sMcpEndpoint "http://100.x.x.x:3001"
```

## Step 3: Deploy

```bash
pulumi up
```

This creates:
- Static IP
- Firewall rules (80, 443, 22)
- n2d-standard-4 VM with Debian 13
- Startup script that installs and configures everything

## Step 4: DNS Records (Porkbun)

After `pulumi up`, it will output the static IP. Create these A records in Porkbun:

| Type | Name | Value |
|------|------|-------|
| A | sark.flatline.ai | (static IP from output) |
| A | foundry.flatline.ai | (static IP from output) |

## Step 5: Verify

```bash
# SSH in and watch the startup script
gcloud compute ssh sark --zone=us-west1-b --project=foundry-487415
sudo tail -f /var/log/sark-startup.log

# Check services
sudo systemctl status caddy
sudo systemctl status foundryvtt
tailscale status

# Test endpoints (after DNS propagates and Caddy gets TLS certs)
curl -I https://foundry.flatline.ai
curl -I https://sark.flatline.ai/healthz
```

## Step 6: Set Up kubernetes-mcp-server on the Homelab

On whichever homelab machine has kubectl access to your cluster, run the
`containers/kubernetes-mcp-server` in HTTP mode:

```bash
# Option A: Download the binary
# See https://github.com/containers/kubernetes-mcp-server/releases
./kubernetes-mcp-server --transport http --port 3001

# Option B: Run via container
docker run -d \
  --name k8s-mcp \
  --restart unless-stopped \
  -p 3001:3001 \
  -v ~/.kube:/home/user/.kube:ro \
  ghcr.io/containers/kubernetes-mcp-server:latest \
  --transport http --port 3001
```

The server will be accessible at `http://<tailnet-ip>:3001` from sark via
Tailscale. Update the `k8sMcpEndpoint` config if the IP/port differs.

## Saving Money

The VM is n2d-standard-4 (~$100/month if always on). To save money when
not running game sessions:

```bash
# Stop the VM (keeps disk, releases compute)
gcloud compute instances stop sark --zone=us-west1-b --project=foundry-487415

# Start it back up for game night
gcloud compute instances start sark --zone=us-west1-b --project=foundry-487415
```

The static IP costs ~$2.40/month even when the VM is stopped, which is
the price of not having to update DNS every time.

## Adding More MCP Servers

To add a new MCP backend (e.g., foundry-vtt-mcp):

1. Run the MCP server on your tailnet
2. Edit the Caddyfile (on the VM at `/etc/caddy/Caddyfile`):
   ```
   route /vtt/* {
     authorize with mcp_policy
     uri strip_prefix /vtt
     reverse_proxy http://TAILNET_IP:PORT
   }
   ```
3. `sudo systemctl reload caddy`

Or better — update the startup script in `index.ts` and `pulumi up` to
keep infrastructure as code.

## Troubleshooting

```bash
# Caddy logs
sudo journalctl -u caddy -f

# Foundry logs
sudo journalctl -u foundryvtt -f

# Startup script log
sudo cat /var/log/sark-startup.log

# Tailscale status
tailscale status

# Check if Foundry is listening
curl -s http://127.0.0.1:30000 | head -20

# Check if k8s MCP is reachable via tailnet
curl -s http://100.x.x.x:3001/healthz

# Re-run startup script after changes
sudo /usr/bin/google_metadata_script_runner startup

# Rebuild caddy with plugins (if plugin is missing)
sudo xcaddy build --with github.com/greenpau/caddy-security@latest --output /usr/bin/caddy
sudo systemctl restart caddy
```
