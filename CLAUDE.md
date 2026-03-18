# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pulumi TypeScript IaC for homelab and personal infrastructure. Independent stacks under `projects/`:

- **tailgate** — GCP f1-micro VM running Tailscale + nginx as a reverse proxy to protect Vercel admin routes with a shared secret header. Providers: GCP, Tailscale, Vercel, Random.
- **the-library** — Kubernetes cluster infrastructure (targets a k3s homelab cluster). Deploys: Tailscale operator, Synology CSI driver, MinIO, and full LGTM observability stack (Loki, Grafana, Tempo, Prometheus, Alloy). Provider: Kubernetes only.
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

**Namespacing.** One namespace per logical component: `tailscale`, `synology-csi`, `minio`, `monitoring`, `gitea`, `agenta`.

## Configuration

Stack configs (`Pulumi.dev.yaml`) are gitignored. Secrets are stored via Pulumi's built-in encryption (`pulumi config set --secret`). A `.template` file exists for tailgate showing required config keys.

Key config patterns:
- Secrets: OAuth creds, API keys, admin passwords → `config.requireSecret()`
- Optional with defaults: zone, hostname, PVC sizes → `config.get() ?? "default"`
- Required plain: project names, host addresses → `config.require()`

## Alloy Config

Alloy (OTLP collector) uses Alloy River syntax embedded as a string in the Helm values, not YAML. The pipeline is: OTLP receiver → batch processor → exporters (Prometheus remote_write, Loki push, Tempo OTLP).

## Key Endpoints (Tailscale hostnames)

- `grafana` — Grafana UI (port 80 → 3000)
- `minio` / `minio-console` — MinIO API / Console
- `alloy-otlp-grpc:4317` / `alloy-otlp-http:4318` — OTLP ingest
- `gitea` — Gitea web UI (port 80 → 3000)
- `gitea-ssh` — Gitea SSH (port 22)
- `agenta` — Agenta web UI (HTTPS via Tailscale Ingress, path routing: /api, /services, /)
