# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pulumi TypeScript IaC for homelab and personal infrastructure. Independent stacks under `projects/`:

- **tailgate** — GCP f1-micro VM running Tailscale + nginx as a reverse proxy to protect Vercel admin routes with a shared secret header. Providers: GCP, Tailscale, Vercel, Random.
- **the-library** — Kubernetes cluster infrastructure (targets a k3s homelab cluster). Deploys: Tailscale operator, Synology CSI driver, MinIO, cert-manager, CloudNativePG operator + Barman Cloud backup plugin, and full LGTM observability stack (Loki, Grafana, Tempo, Prometheus, Alloy). Provider: Kubernetes only.
- **library-applications** — User-facing applications on the k3s cluster. Deploys: Gitea (self-hosted Git), Agenta (LLM prompt management). Depends on storage classes and Tailscale operator from the-library. Agenta uses Tailscale Ingress for HTTPS with path-based routing.

## Commands

Each project is self-contained. Always `cd` into the project directory first.

```bash
cd projects/tailgate   # or projects/the-library, projects/library-applications
npm install            # install deps (tailgate uses pnpm, the-library uses npm)
pulumi preview         # dry-run
pulumi up              # deploy
pulumi destroy         # tear down
pulumi stack output    # view exports
```

There are no tests, linters, or build steps. The TypeScript is executed directly by Pulumi's runtime.

## Architecture Patterns

**Single-file stacks.** Each project is one `index.ts` — no shared modules, no component abstractions. This is intentional; inline everything for visibility.

**Helm via `k8s.helm.v4.Chart`.** The-library deploys all Helm charts using the v4 API. Manual `k8s.core.v1.Service` resources are created alongside charts when `loadBalancerClass: "tailscale"` isn't supported by the chart's values schema.

**Explicit dependency chains.** Synology CSI must deploy before anything that needs persistent storage (`dependsOn: [synologyCsi]`). Grafana depends on Loki, Prometheus, and Tempo. Follow this pattern when adding new stateful services.

**Tailscale as the network layer.** All external access goes through Tailscale LoadBalancer services with `tailscale.com/hostname` annotations. No public ingress.

**Synology CSI storage.** Two storage classes: `synology-csi-iscsi-delete` and `synology-csi-iscsi-retain`. Use `iscsi-retain` for anything stateful. The CSI chart expects a pre-created `synology-csi-client-info` secret.

**Tailscale Ingress for HTTPS apps.** For HTTP services that need TLS, use `ingressClassName: "tailscale"` — the operator auto-provisions Let's Encrypt certs. Supports path-based routing. Requires MagicDNS + HTTPS enabled in Tailscale admin. Only works with services that have a real ClusterIP (not headless). See Agenta and Grafana for the pattern. For services with headless ClusterIPs (e.g. Gitea) or non-HTTP protocols (SSH), use Tailscale LoadBalancer Services instead.

**CloudNativePG for Postgres.** The CNPG operator (in `cnpg-system` namespace) manages Postgres clusters declaratively via CRDs. Barman Cloud plugin handles backups to MinIO (`cnpg-backups` bucket). Individual `Cluster` CRDs live in application namespaces (e.g. library-applications), not in cnpg-system. Prometheus scrapes CNPG metrics via `extraScrapeConfigs` (community chart doesn't support PodMonitor CRDs). See "CNPG Cluster Setup" section below for the backup wiring pattern.

**Namespacing.** One namespace per logical component: `tailscale`, `synology-csi`, `minio`, `cert-manager`, `cnpg-system`, `monitoring`, `gitea`, `agenta`.

## Configuration

Stack configs (`Pulumi.dev.yaml`) are gitignored. Secrets are stored via Pulumi's built-in encryption (`pulumi config set --secret`). A `.template` file exists for tailgate showing required config keys.

Key config patterns:
- Secrets: OAuth creds, API keys, admin passwords → `config.requireSecret()`
- Optional with defaults: zone, hostname, PVC sizes → `config.get() ?? "default"`
- Required plain: project names, host addresses → `config.require()`

## Alloy Config

Alloy (OTLP collector) uses Alloy River syntax embedded as a string in the Helm values, not YAML. The pipeline is: OTLP receiver → batch processor → exporters (Prometheus remote_write, Loki push, Tempo OTLP).

## CNPG Cluster Setup

When creating a new CNPG `Cluster` in an application project, two things must live in the **same namespace** as the Cluster: a MinIO credentials Secret and the backup config on the Cluster spec.

### 1. MinIO Credentials Secret

Store the MinIO root user/password as Pulumi secrets in the app project's stack config, then create:

```typescript
const minioCreds = new k8s.core.v1.Secret("minio-creds", {
  metadata: {
    name: "minio-creds",
    namespace: appNs.metadata.name,
  },
  stringData: {
    ACCESS_KEY_ID: minioAccessKey,      // config.requireSecret("minioAccessKey")
    ACCESS_SECRET_KEY: minioSecretKey,  // config.requireSecret("minioSecretKey")
  },
});
```

### 2. Cluster Backup Config

Add the `backup` block to the CNPG `Cluster` spec. The `destinationPath` should be namespaced per-cluster inside the `cnpg-backups` bucket:

```typescript
backup: {
  barmanObjectStore: {
    destinationPath: "s3://cnpg-backups/<cluster-name>/",
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
```

### 3. Scheduled Backup

Create alongside the Cluster to get daily base backups:

```typescript
const scheduledBackup = new k8s.apiextensions.CustomResource("<cluster>-daily-backup", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "ScheduledBackup",
  metadata: {
    name: "<cluster>-daily",
    namespace: appNs.metadata.name,
  },
  spec: {
    schedule: "0 2 * * *",  // daily at 2 AM UTC
    backupOwnerReference: "self",
    cluster: { name: "<cluster>" },
    method: "barmanObjectStore",
  },
}, { dependsOn: [cluster] });
```

### Application Connection

CNPG auto-creates services and secrets per Cluster:
- **Service**: `<cluster>-rw.<namespace>.svc.cluster.local:5432` (read-write primary)
- **Secret**: `<cluster>-app` — contains `username`, `password`, `host`, `port`, `dbname`, `uri`. Mount or reference the `uri` field as your `DATABASE_URL`.

## Key Endpoints (Tailscale hostnames)

- `grafana` — Grafana UI (port 80 → 3000)
- `minio` / `minio-console` — MinIO API / Console
- `alloy-otlp-grpc:4317` / `alloy-otlp-http:4318` — OTLP ingest
- `gitea` — Gitea web UI (port 80 → 3000)
- `gitea-ssh` — Gitea SSH (port 22)
- `agenta` — Agenta web UI (HTTPS via Tailscale Ingress, path routing: /api, /services, /)
