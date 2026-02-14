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
const foundryLicenseKey = config.requireSecret("foundryLicenseKey");
const foundryDownloadUrl = config.requireSecret("foundryDownloadUrl");
const tailscaleAuthKey = config.requireSecret("tailscaleAuthKey");

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
// Startup Script — orchestrates all the software setup
// ---------------------------------------------------------------------------
const startupScript = pulumi.all([
  googleOauthClientId,
  googleOauthClientSecret,
  authorizedEmail,
  foundryLicenseKey,
  foundryDownloadUrl,
  tailscaleAuthKey,
  k8sMcpEndpoint,
]).apply(([oauthId, oauthSecret, email, fvttLicense, fvttUrl, tsKey, k8sEndpoint]) => `#!/bin/bash
set -euo pipefail
exec > /var/log/sark-startup.log 2>&1
echo "=== Sark startup $(date) ==="

# -------------------------------------------------------------------------
# System packages
# -------------------------------------------------------------------------
apt-get update
apt-get install -y \\
  curl \\
  unzip \\
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
# Foundry VTT
# -------------------------------------------------------------------------
FOUNDRY_USER="foundry"
FOUNDRY_HOME="/opt/foundryvtt"
FOUNDRY_DATA="/opt/foundrydata"

if ! id "$FOUNDRY_USER" &>/dev/null; then
  useradd -r -m -d "$FOUNDRY_HOME" -s /bin/bash "$FOUNDRY_USER"
fi

mkdir -p "$FOUNDRY_HOME" "$FOUNDRY_DATA"

if [ ! -f "$FOUNDRY_HOME/main.mjs" ]; then
  echo "Downloading Foundry VTT..."
  cd /tmp
  curl -fSL -o foundryvtt.zip "${fvttUrl}"
  unzip -o foundryvtt.zip -d "$FOUNDRY_HOME"
  rm foundryvtt.zip
fi

chown -R "$FOUNDRY_USER":"$FOUNDRY_USER" "$FOUNDRY_HOME" "$FOUNDRY_DATA"

# Foundry options.json — run on localhost only, caddy handles TLS
mkdir -p "$FOUNDRY_DATA/Config"
cat > "$FOUNDRY_DATA/Config/options.json" << FVTTCFG
{
  "port": 30000,
  "hostname": "127.0.0.1",
  "routePrefix": null,
  "sslCert": null,
  "sslKey": null,
  "awsConfig": null,
  "dataPath": "$FOUNDRY_DATA",
  "proxySSL": true,
  "proxyPort": 443,
  "minifyStaticFiles": true,
  "updateChannel": "stable",
  "language": "en.core",
  "world": null,
  "serviceConfig": null,
  "licenseKey": "${fvttLicense}"
}
FVTTCFG

chown -R "$FOUNDRY_USER":"$FOUNDRY_USER" "$FOUNDRY_DATA"

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
# Sark MCP Gateway — OAuth-protected
# -----------------------------------------------------------------------
sark.flatline.ai {
  # OAuth callback/portal routes (must be before authorize)
  route /oauth2/* {
    authenticate with myportal
  }

  # Health check endpoint (no auth)
  route /healthz {
    respond "ok" 200
  }

  # k8s MCP server — proxied to tailnet
  route /k8s/* {
    authorize with mcp_policy
    uri strip_prefix /k8s
    reverse_proxy ${k8sEndpoint} {
      header_up Host {host}
      header_up X-Forwarded-For {remote_host}
    }
  }

  # Placeholder for future MCP servers
  # route /vtt/* {
  #   authorize with mcp_policy
  #   uri strip_prefix /vtt
  #   reverse_proxy http://TAILNET_IP:PORT {
  #     header_up Host {host}
  #   }
  # }

  # Default: show a simple status page
  route /* {
    authorize with mcp_policy
    respond "🏮 Sark MCP Gateway — operational" 200
  }
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

// DNS instructions (since Porkbun is managed manually)
export const dnsInstructions = pulumi.interpolate`
Create these CNAME/A records in Porkbun:
  sark.flatline.ai    → A record → ${staticIp.address}
  foundry.flatline.ai → A record → ${staticIp.address}
`;
