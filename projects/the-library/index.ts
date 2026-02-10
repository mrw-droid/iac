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
}, { dependsOn: [synologyCsi] });

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

// Loki — log aggregation (single-binary mode, filesystem backend)
const loki = new k8s.helm.v4.Chart("loki", {
  namespace: monitoringNs.metadata.name,
  chart: "loki",
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
}, { dependsOn: [synologyCsi] });

// Prometheus — metrics (lean: server only, no alertmanager/pushgateway)
const prometheus = new k8s.helm.v4.Chart("prometheus", {
  namespace: monitoringNs.metadata.name,
  chart: "prometheus",
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
}, { dependsOn: [synologyCsi] });

// Tempo — distributed tracing (single-binary, filesystem backend)
const tempo = new k8s.helm.v4.Chart("tempo", {
  namespace: monitoringNs.metadata.name,
  chart: "tempo",
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
}, { dependsOn: [synologyCsi] });

// Grafana — dashboards and visualization
const grafana = new k8s.helm.v4.Chart("grafana", {
  namespace: monitoringNs.metadata.name,
  chart: "grafana",
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
            url: "http://tempo.monitoring:3100",
            access: "proxy",
            isDefault: false,
          },
        ],
      },
    },
  },
}, { dependsOn: [loki, prometheus, tempo] });

// Alloy — OpenTelemetry collector (DaemonSet mode)
const alloy = new k8s.helm.v4.Chart("alloy", {
  namespace: monitoringNs.metadata.name,
  chart: "alloy",
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
