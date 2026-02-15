import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const config = new pulumi.Config("sark-infra");
const gcpConfig = new pulumi.Config("gcp");

const project = gcpConfig.require("project");
const region = gcpConfig.require("region");
const zone = gcpConfig.require("zone");
const machineType = config.require("machineType");

// Secrets — set via `pulumi config set --secret`
const googleOauthClientId = config.requireSecret("googleOauthClientId");
const googleOauthClientSecret = config.requireSecret("googleOauthClientSecret");
const authorizedEmail = config.requireSecret("authorizedEmail");
const tailscaleAuthKey = config.requireSecret("tailscaleAuthKey");
const mcpOauthEncryptionKey = config.requireSecret("mcpOauthEncryptionKey");

// Optional: k8s MCP server endpoint on the tailnet
// e.g. "http://100.x.x.x:3000" or "http://hostname:3000"
const k8sMcpEndpoint = config.get("k8sMcpEndpoint") || "http://127.0.0.1:3001";

// ---------------------------------------------------------------------------
// Network — use default VPC, add firewall rules
// ---------------------------------------------------------------------------
const firewall = new gcp.compute.Firewall("sark-allow-web", {
  project,
  network: "default",
  allows: [
    { protocol: "tcp", ports: ["80", "443"] },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["sark-web"],
  description: "Allow HTTP/HTTPS to sark instances",
});

// Also allow SSH for management
const firewallSsh = new gcp.compute.Firewall("sark-allow-ssh", {
  project,
  network: "default",
  allows: [
    { protocol: "tcp", ports: ["22"] },
  ],
  // Consider restricting to your IP or using IAP instead
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["sark-web"],
  description: "Allow SSH to sark instances",
});

// ---------------------------------------------------------------------------
// Static IP
// ---------------------------------------------------------------------------
const staticIp = new gcp.compute.Address("sark-ip", {
  project,
  region,
  name: "sark-static-ip",
  networkTier: "STANDARD",
});

// ---------------------------------------------------------------------------
// Service Account
// ---------------------------------------------------------------------------
const sa = new gcp.serviceaccount.Account("sark-sa", {
  project,
  accountId: "sark-vm",
  displayName: "Sark VM Service Account",
});

// ---------------------------------------------------------------------------
// Persistent Disk — Foundry VTT data
// ---------------------------------------------------------------------------
const foundryDisk = new gcp.compute.Disk("foundry", {
  project,
  zone,
  name: "foundry",
  size: 20, // GB
  type: "pd-balanced",
});

// ---------------------------------------------------------------------------
// Startup Script — orchestrates all the software setup
// ---------------------------------------------------------------------------
const startupScript = pulumi.all([
  googleOauthClientId,
  googleOauthClientSecret,
  authorizedEmail,
  tailscaleAuthKey,
  k8sMcpEndpoint,
  mcpOauthEncryptionKey,
]).apply(([oauthId, oauthSecret, email, tsKey, k8sEndpoint, encryptionKey]) => `#!/bin/bash
set -euo pipefail
exec > /var/log/sark-startup.log 2>&1
echo "=== Sark startup $(date) ==="

# -------------------------------------------------------------------------
# System packages
# -------------------------------------------------------------------------
apt-get update
apt-get install -y \\
  curl \\
  debian-keyring \\
  debian-archive-keyring \\
  apt-transport-https \\
  gnupg \\
  jq

# -------------------------------------------------------------------------
# Node.js 22 LTS (for Foundry VTT)
# -------------------------------------------------------------------------
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node --version)"

# -------------------------------------------------------------------------
# Caddy
# -------------------------------------------------------------------------
if ! command -v caddy &> /dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \\
    gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \\
    tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Install caddy-security plugin (provides OAuth/OIDC middleware)
# We need to build caddy with the plugin — requires Go for xcaddy
if ! command -v go &> /dev/null; then
  echo "Installing Go toolchain for xcaddy..."
  curl -fsSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz | tar -C /usr/local -xzf -
fi
export PATH=$PATH:/usr/local/go/bin
export HOME=\${HOME:-/root}
export GOPATH=\${GOPATH:-/root/go}
export GOMODCACHE=\${GOMODCACHE:-/root/go/pkg/mod}

caddy_version=$(caddy version | awk '{print $1}')
if ! caddy list-modules 2>/dev/null | grep -q "http.authentication.providers.google"; then
  echo "Building caddy with security plugin..."
  if ! command -v xcaddy &> /dev/null; then
    GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
  fi
  xcaddy build \\
    --with github.com/greenpau/caddy-security@latest \\
    --output /usr/local/bin/caddy-custom
  # Replace the stock caddy binary
  systemctl stop caddy || true
  cp /usr/local/bin/caddy-custom /usr/bin/caddy
fi

echo "Caddy $(caddy version)"

# -------------------------------------------------------------------------
# Tailscale
# -------------------------------------------------------------------------
if ! command -v tailscale &> /dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --authkey="${tsKey}" --hostname=sark --accept-routes || true
echo "Tailscale connected"

# -------------------------------------------------------------------------
# MCP OAuth Proxy
# -------------------------------------------------------------------------
MCP_PROXY_VERSION="v0.0.2"
MCP_PROXY_URL="https://github.com/obot-platform/mcp-oauth-proxy/releases/download/\${MCP_PROXY_VERSION}/mcp-oauth-proxy-linux-amd64"

if [ ! -f /usr/local/bin/mcp-oauth-proxy ] || ! /usr/local/bin/mcp-oauth-proxy --version 2>/dev/null | grep -q "\${MCP_PROXY_VERSION}"; then
  echo "Downloading mcp-oauth-proxy \${MCP_PROXY_VERSION}..."
  curl -fSL -o /usr/local/bin/mcp-oauth-proxy "\${MCP_PROXY_URL}"
  chmod +x /usr/local/bin/mcp-oauth-proxy
fi

if ! id "mcpproxy" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d /var/lib/mcp-oauth-proxy -m mcpproxy
fi

cat > /etc/systemd/system/mcp-oauth-proxy.service << 'MCPSVC'
[Unit]
Description=MCP OAuth 2.1 Proxy
After=network.target tailscaled.service

[Service]
Type=simple
User=mcpproxy
Group=mcpproxy
Environment=HOST=127.0.0.1
Environment=PORT=8080
MCPSVC

# Append environment vars with secrets (can't use heredoc with variable expansion inside 'MCPSVC')
cat >> /etc/systemd/system/mcp-oauth-proxy.service << MCPSVC_ENV
Environment=OAUTH_CLIENT_ID=${oauthId}
Environment=OAUTH_CLIENT_SECRET=${oauthSecret}
Environment=OAUTH_AUTHORIZE_URL=https://accounts.google.com
Environment=SCOPES_SUPPORTED=openid,email,profile
Environment=MCP_SERVER_URL=${k8sEndpoint}
Environment=ENCRYPTION_KEY=${encryptionKey}
MCPSVC_ENV

cat >> /etc/systemd/system/mcp-oauth-proxy.service << 'MCPSVC_END'
ExecStart=/usr/local/bin/mcp-oauth-proxy
Restart=on-failure
RestartSec=5
WorkingDirectory=/var/lib/mcp-oauth-proxy

[Install]
WantedBy=multi-user.target
MCPSVC_END

systemctl daemon-reload
systemctl enable mcp-oauth-proxy
systemctl restart mcp-oauth-proxy
echo "MCP OAuth Proxy started on 127.0.0.1:8080"

# -------------------------------------------------------------------------
# Foundry VTT — persistent disk mount
# -------------------------------------------------------------------------
FOUNDRY_USER="foundry"
FOUNDRY_DISK="/dev/disk/by-id/google-foundry"

if ! id "$FOUNDRY_USER" &>/dev/null; then
  useradd -r -m -d /opt/foundryvtt -s /bin/bash "$FOUNDRY_USER"
fi

# Format the disk if it has no filesystem (first attach only)
if ! blkid "$FOUNDRY_DISK" &>/dev/null; then
  echo "Formatting foundry disk..."
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$FOUNDRY_DISK"
fi

# Mount to /opt (contains foundryvtt/ and foundrydata/ from prior install)
if ! mountpoint -q /opt; then
  mount -o discard,defaults "$FOUNDRY_DISK" /opt
fi

# Persist in fstab
if ! grep -q "google-foundry" /etc/fstab; then
  echo "$FOUNDRY_DISK /opt ext4 discard,defaults,nofail 0 2" >> /etc/fstab
fi

chown -R "$FOUNDRY_USER":"$FOUNDRY_USER" /opt/foundryvtt /opt/foundrydata

# Foundry systemd service
cat > /etc/systemd/system/foundryvtt.service << 'FVTTSVC'
[Unit]
Description=Foundry Virtual Tabletop
After=network.target

[Service]
Type=simple
User=foundry
Group=foundry
ExecStart=/usr/bin/node /opt/foundryvtt/main.mjs --dataPath=/opt/foundrydata
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
FVTTSVC

systemctl daemon-reload
systemctl enable foundryvtt
systemctl start foundryvtt
echo "Foundry VTT started on :30000"

# -------------------------------------------------------------------------
# Caddyfile
# -------------------------------------------------------------------------
cat > /etc/caddy/Caddyfile << CADDYEOF
{
  acme_ca https://acme-v02.api.letsencrypt.org/directory

  order authenticate before respond
  order authorize before reverse_proxy

  security {
    oauth identity provider google {
      realm google
      driver google
      client_id ${oauthId}
      client_secret ${oauthSecret}
      scopes openid email profile
    }

    authentication portal myportal {
      crypto default token lifetime 86400
      enable identity provider google
      cookie domain flatline.ai
      cookie lifetime 86400

      transform user {
        match email ${email}
        action add role authp/user
      }
    }

    authorization policy mcp_policy {
      set auth url /oauth2/google
      allow roles authp/user
    }
  }
}

# -----------------------------------------------------------------------
# Foundry VTT — OAuth-protected, same Google auth as MCP gateway
# -----------------------------------------------------------------------
foundry.flatline.ai {
  # OAuth callback/portal routes (must be before authorize)
  route /oauth2/* {
    authenticate with myportal
  }

  route /* {
    authorize with mcp_policy
    reverse_proxy 127.0.0.1:30000 {
      header_up Host {host}
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }
}

# -----------------------------------------------------------------------
# Sark MCP Gateway — OAuth 2.1 via mcp-oauth-proxy
# -----------------------------------------------------------------------
sark.flatline.ai {
  # Health check at Caddy level
  route /healthz {
    respond "ok" 200
  }

  # Everything else proxied to mcp-oauth-proxy
  reverse_proxy 127.0.0.1:8080
}
CADDYEOF

systemctl restart caddy
echo "Caddy configured and restarted"

echo "=== Sark startup complete $(date) ==="
`);

// ---------------------------------------------------------------------------
// Compute Instance
// ---------------------------------------------------------------------------
const instance = new gcp.compute.Instance("sark", {
  project,
  zone,
  machineType,
  name: "sark",
  tags: ["sark-web"],

  bootDisk: {
    initializeParams: {
      // Debian 13 (Trixie)
      image: "debian-cloud/debian-13",
      size: 50, // GB — Foundry worlds can get chunky
      type: "pd-balanced",
    },
  },

  attachedDisks: [{
    source: foundryDisk.selfLink,
    deviceName: "foundry",
  }],

  networkInterfaces: [{
    network: "default",
    accessConfigs: [{
      natIp: staticIp.address,
      networkTier: "STANDARD",
    }],
  }],

  serviceAccount: {
    email: sa.email,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },

  metadataStartupScript: startupScript,

  // Allow stopping to save money when not in use
  scheduling: {
    automaticRestart: true,
    onHostMaintenance: "MIGRATE",
    preemptible: false,
  },

  metadata: {
    "enable-oslogin": "true",
  },
}, { dependsOn: [firewall, firewallSsh] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const instanceName = instance.name;
export const instanceZone = instance.zone;
export const externalIp = staticIp.address;
export const sshCommand = pulumi.interpolate`gcloud compute ssh sark --zone=${zone} --project=${project}`;
export const startupLog = "sudo tail -f /var/log/sark-startup.log";
export const caddyStatus = "sudo systemctl status caddy";
export const foundryStatus = "sudo systemctl status foundryvtt";
export const mcpOauthProxyStatus = "sudo systemctl status mcp-oauth-proxy";
export const mcpOauthProxyLogs = "sudo journalctl -u mcp-oauth-proxy -f";

// DNS instructions (since Porkbun is managed manually)
export const dnsInstructions = pulumi.interpolate`
Create these CNAME/A records in Porkbun:
  sark.flatline.ai    → A record → ${staticIp.address}
  foundry.flatline.ai → A record → ${staticIp.address}
`;
