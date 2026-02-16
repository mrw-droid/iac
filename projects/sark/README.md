# Sark Infrastructure

> *"I'm Sark. I work for the MCP."*

MCP gateway + Foundry VTT server on GCP. Caddy handles TLS, agentgateway handles JWT-authenticated MCP proxying to backend servers on the tailnet, and Google OAuth protects Foundry VTT.

## Architecture

```
Internet
    │
    ▼
sark.flatline.ai (Caddy TLS → agentgateway, JWT auth)
    └── /*  ──► agentgateway :8081 ──► kubernetes-mcp-server (via tailnet)

foundry.flatline.ai (Caddy TLS + Google OAuth)
    └── /*  ──► Foundry VTT (localhost:30000)

All on a single GCP n2d-standard-4 VM running Debian 13 (Trixie).
Tailscale connects to the homelab tailnet for MCP backend access.
```

## Prerequisites

- Pulumi CLI installed and logged in
- GCP CLI (`gcloud`) authenticated with access to `foundry-487415`
- A Tailscale auth key (create at https://login.tailscale.com/admin/settings/keys)
- Google OAuth credentials (for Foundry VTT access — see below)

## Step 1: Generate JWT Keypair

agentgateway uses JWT tokens for authentication. Generate an EC P-256 keypair and convert the public key to JWKS:

```bash
# Generate EC P-256 private key (keep this local — never upload it)
openssl ecparam -genkey -name prime256v1 -noout -out ~/.creds/sark-jwt-private.pem

# Convert public key to JWKS JSON for agentgateway
uv run --with PyJWT --with cryptography scripts/gen_jwks.py ~/.creds/sark-jwt-private.pem > sark-jwt-public.jwks
```

The private key stays on your machine (`~/.creds/sark-jwt-private.pem`) for minting tokens. The JWKS JSON gets stored in Pulumi config so agentgateway can verify them.

## Step 2: Create Google OAuth Credentials

Required for Foundry VTT access (not MCP — that uses JWT now).

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=foundry-487415)
2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
3. Configure the **OAuth consent screen** if prompted:
   - User Type: **External**, leave in "Testing" mode
   - Scopes: `email`, `profile`, `openid`
   - **Test users**: add your Google email
4. Create OAuth client ID:
   - Application type: **Web application**
   - Name: `Sark MCP Gateway`
   - Authorized redirect URIs: `https://foundry.flatline.ai/oauth2/google/authorization-code-callback`
5. Copy the **Client ID** and **Client Secret**

## Step 3: Configure Pulumi Secrets

```bash
cd projects/sark
pulumi stack init prod

# JWT JWKS (from step 1)
cat sark-jwt-public.jwks | pulumi config set --secret sark-infra:jwtJwks

# Google OAuth (from step 2, for Foundry VTT)
pulumi config set --secret sark-infra:googleOauthClientId "YOUR_CLIENT_ID.apps.googleusercontent.com"
pulumi config set --secret sark-infra:googleOauthClientSecret "GOCSPX-YOUR_SECRET"
pulumi config set --secret sark-infra:authorizedEmail "you@gmail.com"

# Tailscale auth key (ephemeral, reusable recommended)
pulumi config set --secret sark-infra:tailscaleAuthKey "tskey-auth-XXXXX"

# k8s MCP server endpoint on the tailnet
pulumi config set sark-infra:k8sMcpEndpoint "http://100.x.x.x:3001"
```

## Step 4: Deploy

```bash
pulumi up
```

This creates:
- Static IP
- Firewall rules (80, 443, 22)
- n2d-standard-4 VM with Debian 13
- Startup script that installs and configures everything

## Step 5: DNS Records (Porkbun)

After `pulumi up`, it will output the static IP. Create these A records in Porkbun:

| Type | Name | Value |
|------|------|-------|
| A | sark.flatline.ai | (static IP from output) |
| A | foundry.flatline.ai | (static IP from output) |

## Step 6: Verify

```bash
# SSH in and watch the startup script
gcloud compute ssh sark --zone=us-west1-b --project=foundry-487415
sudo tail -f /var/log/sark-startup.log

# Check services
sudo systemctl status caddy
sudo systemctl status agentgateway
sudo systemctl status foundryvtt
tailscale status

# Test endpoints (after DNS propagates and Caddy gets TLS certs)
curl -I https://sark.flatline.ai/healthz
curl -I https://foundry.flatline.ai
```

## Minting JWT Tokens

Use the private key from Step 1 to create tokens for MCP clients:

```bash
uv run --with PyJWT --with cryptography scripts/mint_jwt.py
```

## Connecting Claude

**Claude Code CLI:**
```bash
claude mcp add --transport http tailscale-tools https://sark.flatline.ai/mcp \
  --header "Authorization: Bearer <jwt>"
```

**Claude API (tool_use with MCP):**
```json
{
  "mcp_servers": [{
    "type": "url",
    "url": "https://sark.flatline.ai/mcp",
    "authorization_token": "<jwt>"
  }]
}
```

## Step 7: Set Up kubernetes-mcp-server on the Homelab

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

## Adding More MCP Backends

Add new targets to the agentgateway config in `index.ts` under `backends`:

```yaml
backends:
  - mcp:
      targets:
        - name: k8s-tools
          mcp:
            host: http://100.x.x.x:3001
        - name: new-server
          mcp:
            host: http://100.x.x.x:PORT
```

Then `pulumi up` to redeploy.

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

## Troubleshooting

```bash
# Caddy logs
sudo journalctl -u caddy -f

# Agent Gateway logs
sudo journalctl -u agentgateway -f

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
