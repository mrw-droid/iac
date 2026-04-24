import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as dockerBuild from "@pulumi/docker-build";

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

// Fix Agenta services path routing: the chart's entrypoints/main.py creates
// FastAPI() without root_path, so the /services prefix from the ingress is
// never stripped. The API got this right (FastAPI(root_path="/api")), but the
// services app didn't. We inject a tiny ASGI wrapper via ConfigMap that strips
// the prefix before requests hit the app.
const stripServicesPrefix = [(args: any) => {
  if (args.type === "kubernetes:apps/v1:Deployment" &&
      args.props?.metadata?.labels?.["app.kubernetes.io/component"] === "services") {
    const spec = args.props.spec.template.spec;
    // Add the ConfigMap volume
    spec.volumes = [...(spec.volumes || []), {
      name: "services-wrapper",
      configMap: { name: "agenta-services-wrapper" },
    }];
    // Patch the services container
    for (const c of spec.containers) {
      if (c.name === "services") {
        // Mount the wrapper script into the app directory
        c.volumeMounts = [...(c.volumeMounts || []), {
          name: "services-wrapper",
          mountPath: "/app/services_wrapper.py",
          subPath: "services_wrapper.py",
        }];
        // Swap the gunicorn entrypoint to load the wrapper instead
        c.command = c.command.map((arg: string) =>
          arg === "entrypoints.main:app" ? "services_wrapper:app" : arg
        );
        // The SDK auth middleware calls AGENTA_API_URL to verify credentials.
        // The default (global.apiUrl) is the external Tailscale URL, which
        // hairpins out of the cluster and back — flaky and slow. Rewrite to
        // use the internal cluster service for server-to-server auth.
        for (const e of c.env || []) {
          if (e.name === "AGENTA_API_URL") {
            e.value = "http://agenta-api:8000/api";
          }
        }
      }
    }
    return { props: args.props, opts: args.opts };
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
    strategy: {
      type: "Recreate",
    },
    gitea: {
      admin: {
        username: giteaAdminUser,
        password: giteaAdminPassword,
        email: "gitea@local.domain",
      },
      config: {
        server: {
          DOMAIN: "gitea.vaquita-carp.ts.net",
          ROOT_URL: "https://gitea.vaquita-carp.ts.net",
          SSH_DOMAIN: "gitea-ssh.vaquita-carp.ts.net",
          SSH_PORT: "22",
        },
        ui: {
          PREFERRED_TIMESTAMP_TENSE: "absolute",
        },
        time: {
          FORMAT: "RFC3339",
        },
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

// The chart's gitea-http service is headless (ClusterIP: None), which Tailscale
// Ingress can't route to. Create a non-headless ClusterIP service for the Ingress backend.
const giteaClusterIp = new k8s.core.v1.Service("gitea-clusterip", {
  metadata: {
    name: "gitea-clusterip",
    namespace: giteaNs.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      "app.kubernetes.io/name": "gitea",
      "app.kubernetes.io/instance": "gitea",
    },
    ports: [{
      name: "http",
      port: 3000,
      targetPort: 3000,
    }],
  },
});

// Tailscale Ingress for Gitea — auto-provisions LE certs
const giteaIngress = new k8s.networking.v1.Ingress("gitea-tailscale", {
  metadata: {
    name: "gitea-tailscale",
    namespace: giteaNs.metadata.name,
  },
  spec: {
    ingressClassName: "tailscale",
    tls: [{ hosts: ["gitea"] }],
    rules: [{
      host: "gitea",
      http: {
        paths: [{
          path: "/",
          pathType: "Prefix",
          backend: {
            service: {
              name: "gitea-clusterip",
              port: { number: 3000 },
            },
          },
        }],
      },
    }],
  },
}, { dependsOn: [gitea, giteaClusterIp] });

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
      targetPort: 2222,
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
const agentaImageTag = config.get("agentaImageTag") ?? "v0.94.8";

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

// ASGI wrapper that strips the /services path prefix before forwarding to
// the real app. Necessary because entrypoints/main.py creates FastAPI()
// without root_path — upstream bug in the Agenta Helm chart.
const servicesWrapper = new k8s.core.v1.ConfigMap("agenta-services-wrapper", {
  metadata: {
    name: "agenta-services-wrapper",
    namespace: agentaNs.metadata.name,
  },
  data: {
    "services_wrapper.py": `\
from starlette.types import ASGIApp, Receive, Scope, Send

class StripPrefix:
    """ASGI middleware that strips a path prefix before forwarding."""
    def __init__(self, app: ASGIApp, prefix: str) -> None:
        self.app = app
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            if path.startswith(self.prefix):
                scope = dict(scope, path=path[len(self.prefix):] or "/")
        await self.app(scope, receive, send)

from entrypoints.main import app as _app
app = StripPrefix(_app, "/services")
`,
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
      webUrl: "https://agenta.vaquita-carp.ts.net",
      apiUrl: "https://agenta.vaquita-carp.ts.net/api",
      servicesUrl: "https://agenta.vaquita-carp.ts.net/services",
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
      env: {
        ALEMBIC_AUTO_MIGRATIONS: "true",
        ALEMBIC_CFG_PATH_CORE: "/app/oss/databases/postgres/migrations/core/alembic.ini",
        ALEMBIC_CFG_PATH_TRACING: "/app/oss/databases/postgres/migrations/tracing/alembic.ini",
      },
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
      enabled: false,
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
}, { dependsOn: [agentaSecret, agentaPgauthSecret, servicesWrapper], transforms: [...ignoreK8sDrift, ...stripServicesPrefix] });

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

// --- Flatline (AI agent server — CNPG Postgres) ---

const flatlineNs = new k8s.core.v1.Namespace("flatline", {
  metadata: { name: "flatline" },
});

const minioAccessKey = config.requireSecret("minioAccessKey");
const minioSecretKey = config.requireSecret("minioSecretKey");
const flatlineDbInstances = parseInt(config.get("flatlineDbInstances") ?? "1");
const flatlineDbSize = config.get("flatlineDbSize") ?? "20Gi";
const giteaRegistryUser = config.requireSecret("giteaRegistryUser");
const giteaRegistryPassword = config.requireSecret("giteaRegistryPassword");
const giteaRegistryHost = config.get("giteaRegistryHost") ?? "gitea.vaquita-carp.ts.net";

// Build and push the CNPG + pgvector image to Gitea's container registry
const cnpgPgvectorImage = new dockerBuild.Image("cnpg-pgvector", {
  tags: [pulumi.interpolate`${giteaRegistryHost}/flatline/cnpg-pgvector:17-bookworm`],
  context: { location: "./images/cnpg-pgvector" },
  platforms: [dockerBuild.Platform.Linux_amd64],
  push: true,
  registries: [{
    address: giteaRegistryHost,
    username: giteaRegistryUser,
    password: giteaRegistryPassword,
  }],
});

// MinIO credentials for CNPG backups — must live in the same namespace as the Cluster
const flatlineMinioCreds = new k8s.core.v1.Secret("flatline-minio-creds", {
  metadata: {
    name: "minio-creds",
    namespace: flatlineNs.metadata.name,
  },
  stringData: {
    ACCESS_KEY_ID: minioAccessKey,
    ACCESS_SECRET_KEY: minioSecretKey,
  },
});

// CNPG Cluster: single Postgres instance with pgvector, backups to MinIO
const flatlineDb = new k8s.apiextensions.CustomResource("flatline-db", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: {
    name: "flatline-db",
    namespace: flatlineNs.metadata.name,
  },
  spec: {
    instances: flatlineDbInstances,
    imageName: cnpgPgvectorImage.ref,
    bootstrap: {
      initdb: {
        database: "flatline",
        owner: "flatline",
        postInitSQL: [
          "CREATE EXTENSION IF NOT EXISTS vector;",
        ],
      },
    },
    storage: {
      size: flatlineDbSize,
      storageClass: "synology-csi-iscsi-retain",
    },
    backup: {
      barmanObjectStore: {
        destinationPath: "s3://cnpg-backups/flatline-db/",
        endpointURL: "http://minio.minio.svc.cluster.local:9000",
        s3Credentials: {
          accessKeyId:     { name: "minio-creds", key: "ACCESS_KEY_ID" },
          secretAccessKey: { name: "minio-creds", key: "ACCESS_SECRET_KEY" },
        },
        wal: {
          compression: "gzip",
          maxParallel: 2,
        },
        data: {
          compression: "gzip",
          immediateCheckpoint: true,
        },
      },
      retentionPolicy: "14d",
    },
    monitoring: {
      enablePodMonitor: false,
    },
  },
}, { dependsOn: [flatlineMinioCreds, cnpgPgvectorImage] });

// Daily base backup at 2 AM UTC
const flatlineBackup = new k8s.apiextensions.CustomResource("flatline-db-daily-backup", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "ScheduledBackup",
  metadata: {
    name: "flatline-db-daily",
    namespace: flatlineNs.metadata.name,
  },
  spec: {
    schedule: "0 2 * * *",
    backupOwnerReference: "self",
    cluster: { name: "flatline-db" },
    method: "barmanObjectStore",
  },
}, { dependsOn: [flatlineDb] });

// Tailscale LoadBalancer for Postgres — TCP protocol, so LoadBalancer not Ingress
const flatlineDbTailscale = new k8s.core.v1.Service("flatline-db-tailscale", {
  metadata: {
    name: "flatline-db-tailscale",
    namespace: flatlineNs.metadata.name,
    annotations: {
      "tailscale.com/hostname": "flatline-db",
    },
  },
  spec: {
    type: "LoadBalancer",
    loadBalancerClass: "tailscale",
    selector: {
      "cnpg.io/cluster": "flatline-db",
      role: "primary",
    },
    ports: [{
      name: "postgres",
      port: 5432,
      targetPort: 5432,
    }],
  },
}, { dependsOn: [flatlineDb] });

// Exports
export const giteaNamespace = giteaNs.metadata.name;
export const giteaEndpoint = "gitea";
export const giteaSshEndpoint = "gitea-ssh";
export const agentaNamespace = agentaNs.metadata.name;
export const agentaEndpoint = "https://agenta";
export const flatlineNamespace = flatlineNs.metadata.name;
export const flatlineDbEndpoint = "flatline-db.vaquita-carp.ts.net:5432";
