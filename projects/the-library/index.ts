import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

// Fix K8s state drift that Pulumi can't reconcile:
// - PVCs: K8s sets spec.volumeName after binding; Pulumi sees it as an
//   immutable field change and wants a destructive replace.
// - RBAC: Helm creates Role/ClusterRole with `rules: []` but K8s normalizes
//   that to omitting the field entirely, causing an endless update loop.
const ignoreK8sDrift = [(args: any) => {
  if (args.type === "kubernetes:core/v1:PersistentVolumeClaim") {
    return {
      props: args.props,
      opts: pulumi.mergeOptions(args.opts, {
        ignoreChanges: ["spec.volumeName"],
      }),
    };
  }
  if (args.type === "kubernetes:rbac.authorization.k8s.io/v1:Role" ||
      args.type === "kubernetes:rbac.authorization.k8s.io/v1:ClusterRole") {
    return {
      props: args.props,
      opts: pulumi.mergeOptions(args.opts, {
        ignoreChanges: ["rules"],
      }),
    };
  }
  return undefined;
}];

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
  version: "1.92.5",
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

// --- Synology CSI Driver ---

const synologyNs = new k8s.core.v1.Namespace("synology-csi", {
  metadata: { name: "synology-csi" },
});

const synologyHost = config.require("synologyHost");
const synologyPort = config.getNumber("synologyPort") ?? 5001;
const synologyUsername = config.requireSecret("synologyUsername");
const synologyPassword = config.requireSecret("synologyPassword");

// The Synology CSI Helm chart expects this secret to already exist —
// it mounts it but does NOT create it.
const clientInfoYaml = pulumi.all([synologyUsername, synologyPassword]).apply(
  ([username, password]) => `clients:
  - host: "${synologyHost}"
    port: ${synologyPort}
    https: true
    username: "${username}"
    password: "${password}"
`);

const clientInfoSecret = new k8s.core.v1.Secret("synology-csi-client-info", {
  metadata: {
    name: "synology-csi-client-info",
    namespace: synologyNs.metadata.name,
  },
  stringData: {
    "client-info.yaml": clientInfoYaml,
  },
});

const synologyCsi = new k8s.helm.v4.Chart("synology-csi", {
  namespace: synologyNs.metadata.name,
  chart: "synology-csi",
  version: "0.10.0",
  repositoryOpts: {
    repo: "https://christian-schlichtherle.github.io/synology-csi-chart",
  },
  values: {
    storageClasses: {
      "iscsi-delete": {
        parameters: {
          fsType: "ext4",
        },
      },
      "iscsi-retain": {
        reclaimPolicy: "Retain",
        parameters: {
          fsType: "ext4",
        },
      },
    },
  },
}, { dependsOn: [clientInfoSecret] });

// --- MinIO (S3-compatible object storage) ---

const minioNs = new k8s.core.v1.Namespace("minio", {
  metadata: { name: "minio" },
});

const minioRootUser = config.requireSecret("minioRootUser");
const minioRootPassword = config.requireSecret("minioRootPassword");
const minioPvcSize = config.get("minioPvcSize") ?? "50Gi";

const minio = new k8s.helm.v4.Chart("minio", {
  namespace: minioNs.metadata.name,
  chart: "minio",
  version: "5.4.0",
  repositoryOpts: {
    repo: "https://charts.min.io/",
  },
  values: {
    mode: "standalone",
    replicas: 1,
    rootUser: minioRootUser,
    rootPassword: minioRootPassword,
    persistence: {
      enabled: true,
      storageClass: "synology-csi-iscsi-retain",
      size: minioPvcSize,
    },
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    },
    resources: {
      requests: {
        memory: "512Mi",
      },
    },
  },
}, { dependsOn: [synologyCsi], transforms: ignoreK8sDrift });

// Tailscale-exposed services for MinIO (chart doesn't support loadBalancerClass)
const minioTailscaleApi = new k8s.core.v1.Service("minio-tailscale-api", {
  metadata: {
    name: "minio-tailscale-api",
    namespace: minioNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "minio",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      app: "minio",
      release: "minio",
    },
    ports: [{
      name: "http",
      port: 80,
      targetPort: 9000,
    }],
  },
});

const minioTailscaleConsole = new k8s.core.v1.Service("minio-tailscale-console", {
  metadata: {
    name: "minio-tailscale-console",
    namespace: minioNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "minio-console",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      app: "minio",
      release: "minio",
    },
    ports: [{
      name: "http",
      port: 80,
      targetPort: 9001,
    }],
  },
});

// --- Observability Stack (Loki, Prometheus, Tempo, Grafana, Alloy) ---

const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
  metadata: { name: "monitoring" },
});

const grafanaAdminPassword = config.requireSecret("grafanaAdminPassword");
const grafanaMcpToken = config.requireSecret("grafanaMcpServiceAccountToken");

// Loki — log aggregation (single-binary mode, filesystem backend)
const loki = new k8s.helm.v4.Chart("loki", {
  namespace: monitoringNs.metadata.name,
  chart: "loki",
  version: "6.52.0",
  repositoryOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    deploymentMode: "SingleBinary",
    loki: {
      auth_enabled: false,
      commonConfig: {
        replication_factor: 1,
      },
      schemaConfig: {
        configs: [{
          from: "2024-01-01",
          store: "tsdb",
          object_store: "filesystem",
          schema: "v13",
          index: {
            prefix: "index_",
            period: "24h",
          },
        }],
      },
      storage: {
        type: "filesystem",
      },
    },
    singleBinary: {
      replicas: 1,
      persistence: {
        enabled: true,
        storageClass: "synology-csi-iscsi-retain",
        size: "100Gi",
      },
    },
    gateway: {
      enabled: true,
    },
    // Disable components not needed in single-binary mode
    backend: { replicas: 0 },
    read: { replicas: 0 },
    write: { replicas: 0 },
    chunksCache: { enabled: false },
    resultsCache: { enabled: false },
  },
}, { dependsOn: [synologyCsi], transforms: ignoreK8sDrift });

// Prometheus — metrics (lean: server only, no alertmanager/pushgateway)
const prometheus = new k8s.helm.v4.Chart("prometheus", {
  namespace: monitoringNs.metadata.name,
  chart: "prometheus",
  version: "28.9.0",
  repositoryOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
  values: {
    alertmanager: { enabled: false },
    "prometheus-pushgateway": { enabled: false },
    "kube-state-metrics": { enabled: false },
    "prometheus-node-exporter": { enabled: false },
    server: {
      persistentVolume: {
        enabled: true,
        storageClass: "synology-csi-iscsi-retain",
        size: "100Gi",
      },
      securityContext: {
        runAsUser: 65534,
        runAsGroup: 65534,
        fsGroup: 65534,
      },
    },
  },
}, { dependsOn: [synologyCsi], transforms: ignoreK8sDrift });

// Tempo — distributed tracing (single-binary, filesystem backend)
const tempo = new k8s.helm.v4.Chart("tempo", {
  namespace: monitoringNs.metadata.name,
  chart: "tempo",
  version: "1.24.4",
  repositoryOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    tempo: {
      receivers: {
        otlp: {
          protocols: {
            grpc: { endpoint: "0.0.0.0:4317" },
            http: { endpoint: "0.0.0.0:4318" },
          },
        },
      },
    },
    persistence: {
      enabled: true,
      storageClassName: "synology-csi-iscsi-retain",
      size: "100Gi",
    },
  },
}, { dependsOn: [synologyCsi], transforms: ignoreK8sDrift });

// Grafana — dashboards and visualization
const grafana = new k8s.helm.v4.Chart("grafana", {
  namespace: monitoringNs.metadata.name,
  chart: "grafana",
  version: "10.5.15",
  repositoryOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    adminPassword: grafanaAdminPassword,
    persistence: {
      enabled: true,
      storageClassName: "synology-csi-iscsi-retain",
      size: "50Gi",
    },
    datasources: {
      "datasources.yaml": {
        apiVersion: 1,
        datasources: [
          {
            name: "Loki",
            type: "loki",
            url: "http://loki-gateway.monitoring:80",
            access: "proxy",
            isDefault: false,
          },
          {
            name: "Prometheus",
            type: "prometheus",
            url: "http://prometheus-server.monitoring:80",
            access: "proxy",
            isDefault: true,
          },
          {
            name: "Tempo",
            type: "tempo",
            url: "http://tempo.monitoring:3200",
            access: "proxy",
            isDefault: false,
          },
        ],
      },
    },
  },
}, { dependsOn: [loki, prometheus, tempo], transforms: ignoreK8sDrift });

// Alloy — OpenTelemetry collector (DaemonSet mode)
const alloy = new k8s.helm.v4.Chart("alloy", {
  namespace: monitoringNs.metadata.name,
  chart: "alloy",
  version: "1.6.0",
  repositoryOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    alloy: {
      configMap: {
        content: `
otelcol.receiver.otlp "default" {
  grpc {
    endpoint = "0.0.0.0:4317"
  }
  http {
    endpoint = "0.0.0.0:4318"
  }

  output {
    metrics = [otelcol.processor.batch.default.input]
    logs    = [otelcol.processor.batch.default.input]
    traces  = [otelcol.processor.batch.default.input]
  }
}

otelcol.processor.batch "default" {
  output {
    metrics = [otelcol.exporter.prometheus.default.input]
    logs    = [otelcol.exporter.loki.default.input]
    traces  = [otelcol.exporter.otlp.tempo.input]
  }
}

otelcol.exporter.prometheus "default" {
  forward_to = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint {
    url = "http://prometheus-server.monitoring:80/api/v1/write"
  }
}

otelcol.exporter.loki "default" {
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://loki-gateway.monitoring:80/loki/api/v1/push"
  }
}

otelcol.exporter.otlp "tempo" {
  client {
    endpoint = "tempo.monitoring:4317"
    tls {
      insecure = true
    }
  }
}
`,
      },
    },
    controller: {
      type: "daemonset",
    },
    extraPorts: [
      {
        name: "otlp-grpc",
        port: 4317,
        targetPort: 4317,
        protocol: "TCP",
      },
      {
        name: "otlp-http",
        port: 4318,
        targetPort: 4318,
        protocol: "TCP",
      },
    ],
  },
}, { dependsOn: [loki, prometheus, tempo] });

// Tailscale-exposed services for observability
const grafanaTailscale = new k8s.core.v1.Service("grafana-tailscale", {
  metadata: {
    name: "grafana-tailscale",
    namespace: monitoringNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "grafana",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "app.kubernetes.io/name": "grafana",
      "app.kubernetes.io/instance": "grafana",
    },
    ports: [{
      name: "http",
      port: 80,
      targetPort: 3000,
    }],
  },
});

const alloyOtlpGrpc = new k8s.core.v1.Service("alloy-otlp-grpc", {
  metadata: {
    name: "alloy-otlp-grpc",
    namespace: monitoringNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "alloy-otlp-grpc",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "app.kubernetes.io/name": "alloy",
      "app.kubernetes.io/instance": "alloy",
    },
    ports: [{
      name: "otlp-grpc",
      port: 4317,
      targetPort: 4317,
      protocol: "TCP",
    }],
  },
});

const alloyOtlpHttp = new k8s.core.v1.Service("alloy-otlp-http", {
  metadata: {
    name: "alloy-otlp-http",
    namespace: monitoringNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "alloy-otlp-http",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "app.kubernetes.io/name": "alloy",
      "app.kubernetes.io/instance": "alloy",
    },
    ports: [{
      name: "otlp-http",
      port: 4318,
      targetPort: 4318,
      protocol: "TCP",
    }],
  },
});

// --- Grafana MCP Server ---

const grafanaMcpSecret = new k8s.core.v1.Secret("grafana-mcp-token", {
  metadata: {
    name: "grafana-mcp-token",
    namespace: monitoringNs.metadata.name,
  },
  stringData: {
    token: grafanaMcpToken,
  },
});

const grafanaMcp = new k8s.apps.v1.Deployment("grafana-mcp", {
  metadata: {
    name: "grafana-mcp",
    namespace: monitoringNs.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: "grafana-mcp" } },
    template: {
      metadata: { labels: { app: "grafana-mcp" } },
      spec: {
        containers: [{
          name: "mcp-grafana",
          image: "grafana/mcp-grafana:0.9.0",
          args: ["-t", "streamable-http", "--address", "0.0.0.0:8000"],
          ports: [{ containerPort: 8000, name: "http" }],
          env: [
            { name: "GRAFANA_URL", value: "http://grafana.monitoring.svc.cluster.local" },
            {
              name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
              valueFrom: {
                secretKeyRef: {
                  name: "grafana-mcp-token",
                  key: "token",
                },
              },
            },
          ],
          readinessProbe: {
            httpGet: { path: "/healthz", port: 8000 },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          livenessProbe: {
            httpGet: { path: "/healthz", port: 8000 },
            initialDelaySeconds: 10,
            periodSeconds: 30,
          },
          resources: {
            requests: { memory: "64Mi", cpu: "50m" },
            limits: { memory: "256Mi" },
          },
        }],
      },
    },
  },
}, { dependsOn: [grafana] });

const grafanaMcpTailscale = new k8s.core.v1.Service("grafana-mcp-tailscale", {
  metadata: {
    name: "grafana-mcp-tailscale",
    namespace: monitoringNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "grafana-mcp",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: { app: "grafana-mcp" },
    ports: [{
      name: "http",
      port: 80,
      targetPort: 8000,
    }],
  },
}, { dependsOn: [grafanaMcp] });

// Exports
export const operatorNamespace = ns.metadata.name;
export const synologyCsiNamespace = synologyNs.metadata.name;
export const minioNamespace = minioNs.metadata.name;
export const minioEndpoint = "minio";
export const minioConsoleEndpoint = "minio-console";
export const monitoringNamespace = monitoringNs.metadata.name;
export const grafanaEndpoint = "grafana";
export const alloyOtlpGrpcEndpoint = "alloy-otlp-grpc:4317";
export const alloyOtlpHttpEndpoint = "alloy-otlp-http:4318";
export const grafanaMcpEndpoint = "grafana-mcp";
