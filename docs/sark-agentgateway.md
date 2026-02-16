# Open-source MCP gateways for Claude-to-Tailscale proxying

**agentgateway, the Linux Foundation's Rust-based MCP proxy, is the clear top pick for proxying Claude's MCP requests through a public GCE instance to Streamable HTTP backends on a Tailscale tailnet.** It ships as a zero-dependency static binary, supports Streamable HTTP on both the client and backend sides, offers JWT/API-key/OAuth authentication, handles TLS natively, and hot-reloads YAML config — all without requiring Kubernetes or Envoy. IBM's ContextForge is a strong runner-up with richer admin tooling but heavier Python overhead. Unla rounds out the top three as a lightweight Go alternative, though its auth story for the MCP transport layer is underdocumented.

After evaluating every gateway on the [awesome-mcp-gateways](https://github.com/e2b-dev/awesome-mcp-gateways) list — including Lasso, Docker MCP Gateway, Gate22, Open Edison, Microsoft MCP Gateway, and several others — most were eliminated because they operate as local stdio proxies (Lasso), manage only containerized local servers (Docker MCP Gateway), require Kubernetes (Microsoft MCP Gateway), or lack clear Streamable HTTP support on both sides.

---

## Feature comparison of the top three

| Capability | **agentgateway** | **IBM ContextForge** | **Unla** |
|---|---|---|---|
| Language / runtime | **Rust** (static musl binary) | Python / FastAPI / Uvicorn | Go |
| Streamable HTTP (client-facing) | ✅ Native | ✅ Native | ✅ Native |
| Streamable HTTP (backend proxy) | ✅ `mcp.host:` config | ✅ `url` + `transport` fields | ✅ URL-based config |
| stdio backend support | ✅ Spawns local processes | ✅ Via `mcpgateway.translate` bridge | ❓ Not clearly documented |
| JWT authentication | ✅ Strict/optional/permissive modes | ✅ HS256 + RS256, audience validation | ✅ Management API only |
| API key authentication | ✅ Built-in | ✅ Per-virtual-server scoped keys | ❌ Not confirmed for MCP endpoints |
| Google OAuth / OIDC | ✅ Via MCP Auth spec + ExtAuth | ✅ Dedicated tutorial + SSO config | ✅ OAuth2 + PKCE |
| Native TLS termination | ✅ HTTPS listener with cert/key PEM | ✅ Gunicorn SSL or reverse proxy | ❌ Requires reverse proxy |
| Admin UI | ✅ Port 15000, built into binary | ✅ `/admin` (dev-only, not for production) | ✅ Port 80, web management UI |
| Config hot-reload | ✅ File-watch, no restart | ❌ Requires restart | ❓ Unclear |
| Multi-backend routing | ✅ MCP multiplexing, unified tool list | ✅ Virtual servers aggregate tools | ✅ Router-prefix based |
| RBAC / fine-grained auth | ✅ CEL expressions on JWT claims | ✅ User/team/global scopes | ❓ Limited documentation |
| Docker image | `ghcr.io/agentgateway/agentgateway` | `ghcr.io/ibm/mcp-context-forge` | `ghcr.io/amoylab/unla/allinone` |
| License | Apache 2.0 | Open source (IBM community) | MIT |
| GitHub stars | ~1,745 | ~1,000–3,300 | ~2,000 |
| Backing | Linux Foundation (Solo.io, Microsoft, Apple, AWS, Cisco, Adobe) | IBM (Distinguished Engineer-led) | AmoyLab community |
| Status | Active development, ~v0.12 | **Beta** (v1.0.0-BETA-2) | Rapid development, v0.9.x |

---

## Why agentgateway wins for this use case

Three factors make agentgateway the strongest match. First, it is **purpose-built for exactly this architecture**: a publicly-facing proxy that federates multiple remote MCP servers into a single authenticated endpoint. The YAML config directly expresses "listen on HTTPS, authenticate with JWT, proxy to these Streamable HTTP hosts" — no bridging, no translation layers, no workarounds. Second, the **single static binary with zero dependencies** makes deployment on a GCE VM trivial — download, write config, run as systemd. Third, the project's governance under the **Linux Foundation** with contributions from Microsoft, Apple, AWS, and others signals long-term viability, unlike smaller community projects that could stall.

The authentication model is particularly well-suited. Claude sends `Authorization: Bearer <token>` headers when connecting to remote MCP servers. agentgateway's `jwtAuth` in `strict` mode validates these tokens against a JWKS endpoint or local public key. For Claude's API-based MCP connector, you generate a JWT and pass it as the `authorization_token`. For human admin access, agentgateway supports ExtAuth integration with OAuth2 Proxy or even native Tailscale auth — both documented in release notes.

**Key limitation**: agentgateway is still pre-1.0 (~v0.12) and warns that APIs may change. The enterprise edition gates some features (prompt guards, centralized key storage) behind a commercial license. The open-source version covers all core proxying, auth, TLS, and observability features needed here.

---

## Why ContextForge is the runner-up

IBM's ContextForge offers the **richest feature set** of any open-source MCP gateway: 30+ built-in safety plugins, PII detection, multi-tenant workspaces, and a dedicated Google OAuth SSO tutorial. Its virtual server abstraction lets you compose tools from multiple backends into named endpoints, which is elegant for organizing Tailscale services. The **Admin UI** provides a visual way to add/test/monitor backend servers.

However, it falls short on three fronts. The Python/FastAPI stack carries **higher memory and CPU overhead** than a Rust binary — meaningful on a small GCE instance. The Admin UI comes with an explicit warning: **"Never expose it in production"**, forcing you to either firewall it or disable it and manage everything via API. And the project's **beta status** with potential breaking changes between releases adds operational risk. If you need Google OAuth SSO for human access and don't mind the Python overhead, ContextForge is an excellent choice. For a lean, production-focused proxy, agentgateway is tighter.

---

## Why Unla is third

Unla's Go-based architecture and **all-in-one Docker image** (management UI + API server + MCP gateway in one container via supervisord) make initial setup fast. Its web UI for configuring backend MCP servers is more polished than agentgateway's admin panel for non-technical operators. At **~2,000 stars** and MIT license, it has genuine community momentum.

The critical gap is **authentication on the MCP transport endpoint**. While Unla's management API uses JWT and v0.9.1 added OAuth2 PKCE, there is no documented mechanism for simple Bearer token auth on the public-facing MCP endpoint that Claude would hit. The sample configurations only show proxying to localhost backends, leaving remote Tailscale proxying as plausible but unverified. No native TLS means you must front it with Caddy or nginx regardless. For a team comfortable adding auth at the reverse-proxy layer, Unla works — but agentgateway handles it natively.

---

## Concrete deployment plan: agentgateway on GCE

### Step 1 — Install the binary and set up systemd

```bash
# Download the static musl binary (no dependencies)
VERSION=0.12.0  # check github.com/agentgateway/agentgateway/releases
curl -L -o /usr/local/bin/agentgateway \
  "https://github.com/agentgateway/agentgateway/releases/download/v${VERSION}/agentgateway-linux-amd64-musl"
chmod +x /usr/local/bin/agentgateway

# Create service user and directories
sudo useradd -r -s /sbin/nologin agentgateway
sudo mkdir -p /etc/agentgateway/tls /etc/agentgateway/jwt /var/log/agentgateway
```

Create `/etc/systemd/system/agentgateway.service`:

```ini
[Unit]
Description=agentgateway MCP proxy
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=agentgateway
Group=agentgateway
ExecStart=/usr/local/bin/agentgateway -f /etc/agentgateway/config.yaml
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadOnlyPaths=/etc/agentgateway /etc/letsencrypt
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

### Step 2 — TLS certificates with Let's Encrypt

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d sark.flatline.ai
# Certs land at /etc/letsencrypt/live/sark.flatline.ai/
```

### Step 3 — Generate a JWT signing key

```bash
# Generate an RSA key pair for JWT validation
openssl genrsa -out /etc/agentgateway/jwt/private.pem 2048
openssl rsa -in /etc/agentgateway/jwt/private.pem -pubout -out /etc/agentgateway/jwt/pub-key.pem

# Generate a token for Claude (using any JWT library or jwt.io)
# Claims: {"sub": "claude-mcp", "aud": "sark.flatline.ai", "iss": "sark.flatline.ai", "exp": <far-future>}
```

### Step 4 — Write the gateway config

Create `/etc/agentgateway/config.yaml`:

```yaml
config:
  adminAddr: 127.0.0.1:15000  # Admin UI on localhost only

binds:
  - port: 443
    listeners:
      - name: mcp-public
        protocol: HTTPS
        tls:
          cert: /etc/letsencrypt/live/sark.flatline.ai/fullchain.pem
          key: /etc/letsencrypt/live/sark.flatline.ai/privkey.pem
        routes:
          - name: mcp-tools
            matches:
              - path:
                  pathPrefix: /mcp
            policies:
              cors:
                allowOrigins: ["*"]
                allowHeaders: ["*"]
                exposeHeaders: ["Mcp-Session-Id"]
              jwtAuth:
                mode: strict
                issuer: sark.flatline.ai
                audiences: [sark.flatline.ai]
                jwks:
                  file: /etc/agentgateway/jwt/pub-key.pem
            backends:
              - mcp:
                  targets:
                    # Tailscale backend: code analysis tools
                    - name: code-tools
                      mcp:
                        host: http://100.64.1.10:8080/mcp/
                    # Tailscale backend: database query tools
                    - name: db-tools
                      mcp:
                        host: http://100.64.1.11:8080/mcp/
                    # Tailscale backend: monitoring tools
                    - name: monitoring
                      mcp:
                        host: http://100.64.1.12:9090/mcp/
```

### Step 5 — Start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentgateway
sudo journalctl -u agentgateway -f  # Watch logs
```

### Step 6 — Configure Claude to connect

**Via Claude.ai or the Claude app** (Pro/Max/Team/Enterprise): Go to Settings → Integrations → Add Integration, enter URL `https://sark.flatline.ai/mcp` and the JWT token.

**Via the Claude API** (MCP connector beta):

```json
{
  "mcp_servers": [{
    "type": "url",
    "url": "https://sark.flatline.ai/mcp",
    "name": "tailscale-tools",
    "authorization_token": "<your-jwt-token>"
  }],
  "tools": [{"type": "mcp_toolset", "mcp_server_name": "tailscale-tools"}]
}
```

**Via Claude Code CLI**:
```bash
claude mcp add --transport http tailscale-tools https://sark.flatline.ai/mcp \
  --header "Authorization: Bearer <your-jwt-token>"
```

### Step 7 — Firewall rules

```bash
sudo ufw allow 443/tcp    # HTTPS from internet
sudo ufw deny 15000/tcp   # Block admin UI externally
# Tailscale traffic is handled by tailscaled automatically
```

### Alternative: Docker deployment

```bash
docker run -d \
  --name agentgateway \
  --network host \
  --restart unless-stopped \
  -v /etc/agentgateway/config.yaml:/cfg/config.yaml:ro \
  -v /etc/letsencrypt/live/sark.flatline.ai:/tls:ro \
  -v /etc/agentgateway/jwt:/jwt:ro \
  ghcr.io/agentgateway/agentgateway:latest \
  --file=/cfg/config.yaml
```

Using `--network host` ensures the container can reach Tailscale IPs (100.x.y.z) directly. If you prefer bridge networking, you'd need to route Tailscale traffic into the container, which adds complexity.

---

## Gotchas and operational notes

**stdio backends in Docker require extra work.** If you need stdio MCP servers (like `npx @modelcontextprotocol/server-filesystem`), run agentgateway as a systemd binary rather than Docker, since stdio backends spawn child processes that need the tools installed on the host. Alternatively, build a custom Docker image with Node.js/Python pre-installed.

**The admin UI rewrites your config file** and strips YAML comments. Access it via SSH tunnel (`ssh -L 15000:127.0.0.1:15000 user@sark.flatline.ai`) and keep a version-controlled copy of your config.

**Let's Encrypt cert renewal** needs a hook to reload agentgateway. Since agentgateway watches config file changes but not TLS cert file changes, add a `--deploy-hook "systemctl restart agentgateway"` to your certbot renewal cron. Alternatively, front agentgateway with Caddy (which handles cert renewal automatically) and run agentgateway on HTTP internally.

**MCP target names cannot contain underscores** — use hyphens (`code-tools`, not `code_tools`).

**Enterprise-only features** in Solo's commercial edition include prompt guards, secure elicitation, and centralized API key storage. The open-source version covers everything needed for this use case: proxying, auth, TLS, multiplexing, and observability.

## Conclusion

For a GCE instance bridging Claude to Tailscale-internal MCP servers, **agentgateway delivers the tightest fit between requirements and capabilities**: native Streamable HTTP on both sides, JWT auth that matches Claude's Bearer token flow, TLS termination without an extra proxy, YAML config with hot-reload, and a Rust binary that runs comfortably on an `e2-small` instance. ContextForge is worth considering if you need Google OAuth SSO for human operators or want the richer plugin ecosystem, but its Python runtime and beta-quality Admin UI add friction. Unla is the simplest to get running but requires a reverse proxy for both TLS and auth — defeating the "single-service simplicity" goal. Start with agentgateway, generate a long-lived JWT for Claude, and iterate from there.