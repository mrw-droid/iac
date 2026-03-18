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

// --- Gitea (self-hosted Git) ---

const giteaNs = new k8s.core.v1.Namespace("gitea", {
  metadata: { name: "gitea" },
});

const giteaAdminUser = config.requireSecret("giteaAdminUser");
const giteaAdminPassword = config.requireSecret("giteaAdminPassword");
const giteaPvcSize = config.get("giteaPvcSize") ?? "100Gi";

const gitea = new k8s.helm.v4.Chart("gitea", {
  namespace: giteaNs.metadata.name,
  chart: "oci://docker.gitea.com/charts/gitea",
  version: "12.5.0",
  values: {
    global: {
      storageClass: "synology-csi-iscsi-retain",
    },
    gitea: {
      admin: {
        username: giteaAdminUser,
        password: giteaAdminPassword,
        email: "gitea@local.domain",
      },
    },
    persistence: {
      enabled: true,
      size: giteaPvcSize,
    },
    "postgresql-ha": {
      enabled: true,
      persistence: {
        enabled: true,
        size: giteaPvcSize,
      },
    },
    service: {
      http: {
        type: "ClusterIP",
        port: 3000,
      },
      ssh: {
        type: "ClusterIP",
        port: 22,
      },
    },
  },
}, { transforms: ignoreK8sDrift });

// Gitea HTTP stays as LB Service — gitea-http is headless (ClusterIP: None),
// which Tailscale Ingress can't route to.
const giteaTailscaleHttp = new k8s.core.v1.Service("gitea-tailscale-http", {
  metadata: {
    name: "gitea-tailscale-http",
    namespace: giteaNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "gitea",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "app.kubernetes.io/name": "gitea",
      "app.kubernetes.io/instance": "gitea",
    },
    ports: [{
      name: "http",
      port: 80,
      targetPort: 3000,
    }],
  },
});

const giteaTailscaleSsh = new k8s.core.v1.Service("gitea-tailscale-ssh", {
  metadata: {
    name: "gitea-tailscale-ssh",
    namespace: giteaNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "gitea-ssh",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "app.kubernetes.io/name": "gitea",
      "app.kubernetes.io/instance": "gitea",
    },
    ports: [{
      name: "ssh",
      port: 22,
      targetPort: 22,
    }],
  },
});

// --- Agenta (LLM prompt management & observability) ---

const agentaNs = new k8s.core.v1.Namespace("agenta", {
  metadata: { name: "agenta" },
});

const agentaAuthKey = config.requireSecret("agentaAuthKey");
const agentaCryptKey = config.requireSecret("agentaCryptKey");
const agentaPostgresPassword = config.requireSecret("agentaPostgresPassword");
const anthropicApiKey = config.requireSecret("anthropicApiKey");
const agentaImageTag = config.get("agentaImageTag") ?? "v0.94.5";

// All Agenta images are amd64-only (supercronic, API workers, etc.)
const amd64NodeSelector = { "kubernetes.io/arch": "amd64" };

// Pulumi skips Helm hooks — the chart's secrets use helm.sh/hook: pre-install
// so we must create them explicitly.
const agentaSecret = new k8s.core.v1.Secret("agenta-secret", {
  metadata: {
    name: "agenta",
    namespace: agentaNs.metadata.name,
  },
  stringData: {
    AGENTA_AUTH_KEY: agentaAuthKey,
    AGENTA_CRYPT_KEY: agentaCryptKey,
    POSTGRES_PASSWORD: agentaPostgresPassword,
    ANTHROPIC_API_KEY: anthropicApiKey,
  },
});

const agentaPgauthSecret = new k8s.core.v1.Secret("agenta-pgauth", {
  metadata: {
    name: "agenta-pgauth",
    namespace: agentaNs.metadata.name,
  },
  stringData: {
    POSTGRES_PASSWORD: agentaPostgresPassword,
  },
});

const agenta = new k8s.helm.v4.Chart("agenta", {
  namespace: agentaNs.metadata.name,
  chart: "./charts/agenta/hosting/helm/agenta-oss",
  values: {
    // Chart name is "agenta-oss" — without this override the fullname template
    // produces "agenta-agenta-oss" (release-chartname). Pin it to just "agenta".
    fullnameOverride: "agenta",
    global: {
      webUrl: "https://agenta",
      apiUrl: "https://agenta/api",
      servicesUrl: "https://agenta/services",
    },
    secrets: {
      agentaAuthKey: agentaAuthKey,
      agentaCryptKey: agentaCryptKey,
      postgresPassword: agentaPostgresPassword,
      llmProviders: {
        ANTHROPIC_API_KEY: anthropicApiKey,
      },
    },
    api: {
      image: { tag: agentaImageTag },
      nodeSelector: amd64NodeSelector,
    },
    web: {
      image: { tag: agentaImageTag },
      nodeSelector: amd64NodeSelector,
    },
    services: {
      image: { tag: agentaImageTag },
      nodeSelector: amd64NodeSelector,
    },
    workerEvaluations: {
      nodeSelector: amd64NodeSelector,
    },
    workerTracing: {
      nodeSelector: amd64NodeSelector,
    },
    cron: {
      enabled: false,
    },
    alembic: {
      nodeSelector: amd64NodeSelector,
    },
    supertokens: {
      nodeSelector: amd64NodeSelector,
    },
    postgresql: {
      enabled: true,
      primary: {
        persistence: {
          size: "20Gi",
          storageClass: "synology-csi-iscsi-retain",
        },
      },
    },
    redisDurable: {
      nodeSelector: amd64NodeSelector,
      persistence: {
        enabled: true,
        size: "10Gi",
        storageClass: "synology-csi-iscsi-retain",
      },
    },
    redisVolatile: {
      nodeSelector: amd64NodeSelector,
    },
    // Disable the chart's Traefik ingress — we use a Tailscale Ingress instead
    ingress: {
      enabled: false,
    },
  },
}, { dependsOn: [agentaSecret, agentaPgauthSecret], transforms: ignoreK8sDrift });

// Alembic migration job — another Helm hook that Pulumi skips.
// Runs the DB schema migrations that create tables (users, etc.)
const alembicJob = new k8s.batch.v1.Job("agenta-alembic", {
  metadata: {
    name: "agenta-alembic",
    namespace: agentaNs.metadata.name,
    labels: {
      "app.kubernetes.io/component": "alembic",
    },
  },
  spec: {
    activeDeadlineSeconds: 600,
    backoffLimit: 3,
    ttlSecondsAfterFinished: 300,
    template: {
      metadata: {
        labels: {
          "app.kubernetes.io/component": "alembic",
        },
      },
      spec: {
        restartPolicy: "Never",
        nodeSelector: amd64NodeSelector,
        initContainers: [{
          name: "wait-for-postgres",
          image: "busybox:1.36",
          command: ["sh", "-c", `
            echo "Waiting for PostgreSQL at agenta-postgresql:5432..."
            until nc -z agenta-postgresql 5432; do
              echo "PostgreSQL not ready, retrying in 2s..."
              sleep 2
            done
            echo "PostgreSQL is ready."
          `],
        }],
        containers: [{
          name: "alembic",
          image: pulumi.interpolate`ghcr.io/agenta-ai/agenta-api:${agentaImageTag}`,
          command: ["sh", "-c", "python -m oss.databases.postgres.migrations.runner"],
          env: [
            { name: "AGENTA_LICENSE", value: "oss" },
            { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "agenta", key: "POSTGRES_PASSWORD" } } },
            { name: "AGENTA_AUTH_KEY", valueFrom: { secretKeyRef: { name: "agenta", key: "AGENTA_AUTH_KEY" } } },
            { name: "AGENTA_CRYPT_KEY", valueFrom: { secretKeyRef: { name: "agenta", key: "AGENTA_CRYPT_KEY" } } },
            { name: "POSTGRES_URI_CORE", value: "postgresql+asyncpg://agenta:$(POSTGRES_PASSWORD)@agenta-postgresql:5432/agenta_oss_core" },
            { name: "POSTGRES_URI_TRACING", value: "postgresql+asyncpg://agenta:$(POSTGRES_PASSWORD)@agenta-postgresql:5432/agenta_oss_tracing" },
            { name: "POSTGRES_URI_SUPERTOKENS", value: "postgresql://agenta:$(POSTGRES_PASSWORD)@agenta-postgresql:5432/agenta_oss_supertokens" },
            { name: "REDIS_URI", value: "redis://agenta-redis-volatile:6379/0" },
            { name: "REDIS_URI_VOLATILE", value: "redis://agenta-redis-volatile:6379/0" },
            { name: "REDIS_URI_DURABLE", value: "redis://agenta-redis-durable:6381/0" },
            { name: "SUPERTOKENS_CONNECTION_URI", value: "http://agenta-supertokens:3567" },
            { name: "AGENTA_WEB_URL", value: "http://agenta" },
            { name: "AGENTA_API_URL", value: "http://agenta/api" },
            { name: "AGENTA_SERVICES_URL", value: "http://agenta/services" },
            { name: "ALEMBIC_AUTO_MIGRATIONS", value: "true" },
            { name: "ALEMBIC_CFG_PATH_CORE", value: "/app/oss/databases/postgres/migrations/core/alembic.ini" },
            { name: "ALEMBIC_CFG_PATH_TRACING", value: "/app/oss/databases/postgres/migrations/tracing/alembic.ini" },
          ],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { memory: "512Mi" },
          },
        }],
      },
    },
  },
}, { dependsOn: [agenta, agentaSecret] });

// Tailscale Ingress for Agenta — auto-provisions LE certs, handles path routing
const agentaIngress = new k8s.networking.v1.Ingress("agenta-tailscale", {
  metadata: {
    name: "agenta-tailscale",
    namespace: agentaNs.metadata.name,
  },
  spec: {
    ingressClassName: "tailscale",
    tls: [{ hosts: ["agenta"] }],
    rules: [{
      host: "agenta",
      http: {
        paths: [
          {
            path: "/api",
            pathType: "Prefix",
            backend: {
              service: {
                name: "agenta-api",
                port: { number: 8000 },
              },
            },
          },
          {
            path: "/services",
            pathType: "Prefix",
            backend: {
              service: {
                name: "agenta-services",
                port: { number: 80 },
              },
            },
          },
          {
            path: "/",
            pathType: "Prefix",
            backend: {
              service: {
                name: "agenta-web",
                port: { number: 3000 },
              },
            },
          },
        ],
      },
    }],
  },
}, { dependsOn: [agenta] });

// Exports
export const giteaNamespace = giteaNs.metadata.name;
export const giteaEndpoint = "gitea";
export const giteaSshEndpoint = "gitea-ssh";
export const agentaNamespace = agentaNs.metadata.name;
export const agentaEndpoint = "https://agenta";
