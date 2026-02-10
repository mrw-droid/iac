import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

// OAuth credentials (stored as Pulumi secrets)
const oauthClientId = config.requireSecret("tailscaleOAuthClientId");
const oauthClientSecret = config.requireSecret("tailscaleOAuthClientSecret");

// Create tailscale namespace
const ns = new k8s.core.v1.Namespace("tailscale", {
  metadata: { name: "tailscale" },
});

// Deploy Tailscale operator via Helm
const tailscaleOperator = new k8s.helm.v4.Chart("tailscale-operator", {
  namespace: ns.metadata.name,
  chart: "tailscale-operator",
  repositoryOpts: {
    repo: "https://pkgs.tailscale.com/helmcharts",
  },
  values: {
    oauth: {
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
    },
  },
});

// Exports
export const operatorNamespace = ns.metadata.name;
