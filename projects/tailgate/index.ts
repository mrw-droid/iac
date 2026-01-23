import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";
import * as tailscale from "@pulumi/tailscale";
import * as vercel from "@pulumiverse/vercel";

const config = new pulumi.Config();
const stack = pulumi.getStack();

// =============================================================================
// Tailnet Secret (merged from shared)
// =============================================================================

// Allow user to provide their own tailnet secret, otherwise generate one
const providedTailnetSecret = config.getSecret("tailnetSecret");

const generatedSecret = new random.RandomPassword("tailnet-secret", {
  length: 64,
  special: false,
});

// Use provided secret if available, otherwise use generated one
const tailnetSecret = providedTailnetSecret ?? generatedSecret.result;

// =============================================================================
// Vercel Project (lookup existing, manage TAILNET_SECRET only)
// =============================================================================

const vercelProjectName = config.require("vercelProjectName");

// Look up the existing Vercel project (created by Vercel-MongoDB integration)
const vercelProject = vercel.getProjectOutput({ name: vercelProjectName });

// Set the TAILNET_SECRET environment variable
const tailnetSecretEnv = new vercel.ProjectEnvironmentVariable(
  "tailnet-secret",
  {
    projectId: vercelProject.id,
    key: "TAILNET_SECRET",
    value: tailnetSecret,
    targets: ["production", "preview"],
  },
);

// Get the domain for the upstream proxy target
const vercelDomain = pulumi.interpolate`${vercelProjectName}.vercel.app`;

// =============================================================================
// GCP + Tailscale VM (the actual tailgate)
// =============================================================================

// Configuration
const gcpZone = config.get("zone") ?? "us-central1-a";
const tailnetName = config.require("tailnetName"); // e.g., "yourtailnet.ts.net" or just the tailnet name
const hostname = config.get("hostname") ?? "admin";

// Create a Tailscale auth key for the VM
const authKey = new tailscale.TailnetKey("tailgate-auth-key", {
  reusable: false,
  ephemeral: false,
  preauthorized: true,
  tags: ["tag:server"],
  expiry: 3600, // 1 hour - only needed during initial setup
});

// Startup script that installs Tailscale and nginx
const startupScript = pulumi
  .all([authKey.key, tailnetSecret, vercelDomain, hostname, tailnetName])
  .apply(([authKeyValue, secret, upstream, host, tailnet]) => {
    // Determine the full hostname for certs
    const fullHostname = tailnet.includes(".")
      ? `${host}.${tailnet}`
      : `${host}.${tailnet}.ts.net`;

    return `#!/bin/bash
set -e

LOG_FILE="/var/log/tailgate-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Tailgate Setup Started: $(date) ==="

# Install Tailscale
echo "Installing Tailscale..."
curl -fsSL https://tailscale.com/install.sh | sh

# Start Tailscale with the auth key
echo "Starting Tailscale..."
tailscale up --authkey="${authKeyValue}" --hostname="${host}"

# Wait for Tailscale to be ready
echo "Waiting for Tailscale connection..."
sleep 10
tailscale status

# Create cert directory
mkdir -p /etc/tailscale-certs

# Get HTTPS certificate from Tailscale
echo "Obtaining Tailscale certificate..."
tailscale cert --cert-file /etc/tailscale-certs/cert.pem \
  --key-file /etc/tailscale-certs/key.pem \
  "${fullHostname}"

# Install nginx
echo "Installing nginx..."
apt-get update
apt-get install -y nginx

# Configure nginx
echo "Configuring nginx..."
cat > /etc/nginx/sites-available/tailgate << 'NGINX_CONFIG'
server {
    listen 443 ssl http2;
    server_name ${fullHostname};

    ssl_certificate /etc/tailscale-certs/cert.pem;
    ssl_certificate_key /etc/tailscale-certs/key.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass https://${upstream};
        proxy_ssl_server_name on;
        proxy_set_header Host ${upstream};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The magic header that grants admin access
        proxy_set_header X-Tailnet-Secret "${secret}";
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name ${fullHostname};
    return 301 https://$server_name$request_uri;
}
NGINX_CONFIG

# Enable the site
ln -sf /etc/nginx/sites-available/tailgate /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and reload nginx
nginx -t
systemctl restart nginx
systemctl enable nginx

echo "=== Tailgate Setup Complete: $(date) ==="
echo "Access your site at: https://${fullHostname}"
`;
  });

// Create the VM
const vm = new gcp.compute.Instance("tailgate", {
  name: `tailgate-${stack}`,
  machineType: "f1-micro",
  zone: gcpZone,

  bootDisk: {
    initializeParams: {
      image: "debian-cloud/debian-12",
      size: 10,
    },
  },

  networkInterfaces: [
    {
      network: "default",
      accessConfigs: [{}], // Ephemeral external IP for initial setup
    },
  ],

  metadataStartupScript: startupScript,

  tags: ["tailgate", "allow-ssh"],

  serviceAccount: {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },

  labels: {
    purpose: "tailgate",
    stack: stack,
  },
});

// Firewall rule to allow SSH (useful for debugging)
const sshFirewall = new gcp.compute.Firewall("allow-ssh-tailgate", {
  network: "default",
  allows: [
    {
      protocol: "tcp",
      ports: ["22"],
    },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["allow-ssh"],
});

// =============================================================================
// Exports
// =============================================================================

// Secret (for reference/debugging - marked as secret)
export const tailnetSecretValue = pulumi.secret(tailnetSecret);

// Vercel
export const vercelProjectId = vercelProject.id;

// GCP VM
export const vmName = vm.name;
export const vmZone = vm.zone;
export const vmExternalIp = vm.networkInterfaces.apply(
  (nis) => nis[0].accessConfigs?.[0].natIp,
);

// Access URLs
export const tailgateUrl = pulumi.interpolate`https://${hostname}.${tailnetName}${tailnetName.includes(".") ? "" : ".ts.net"}`;
export const sshCommand = pulumi.interpolate`gcloud compute ssh ${vm.name} --zone=${gcpZone}`;
