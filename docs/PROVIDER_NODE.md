# Provider Node

Provider Node is the supplier-side runtime for Wokey. It runs locally, exposes a loopback-only console, connects outbound to Wokey Platform, and provides official-exit network capacity.

## Local Runtime

- Console: `http://127.0.0.1:16888`
- macOS install root: `/usr/local/wokey-provider-node`
- Linux install root: `/opt/wokey-provider-node`
- macOS config: `~/Library/Application Support/Wokey Provider Node/provider-node.json`
- Linux config: `${XDG_CONFIG_HOME:-~/.config}/wokey-provider-node/provider-node.json`
- Default Platform bridge: `wss://node.wokey.ai:8443/internal/provider/connect`

Provider Node listens only for the local console. It does not expose a public server for Wokey Platform; the bridge is an outbound WebSocket connection.

## Trust Boundary

Official-exit requests use Provider Node as an encrypted network exit:

1. Wokey Platform constructs the vendor HTTPS request.
2. Provider Node opens a TCP connection to the vendor host and relays bytes.
3. Platform performs TLS and sends the vendor request through that socket.
4. Provider Node does not terminate TLS and does not read prompts, responses, or vendor authorization headers.

During credential onboarding, a provider explicitly authorizes or imports an OAuth credential. The selected OAuth credential bundle is uploaded to Wokey Platform's encrypted credential store so Platform can construct official vendor requests.

By default the node only dials official vendor domains for currently supported official-exit vendors:

- OpenAI / Codex: `*.openai.com`, `*.chatgpt.com`
- Anthropic / Claude: `*.anthropic.com`, `*.claude.com`
- Qwen: `dashscope.aliyuncs.com`, `dashscope-us.aliyuncs.com`
- Zhipu AI: `*.bigmodel.cn`, `*.z.ai`
- Moonshot / Kimi: `*.kimi.com`, `*.moonshot.ai`, `*.moonshot.cn`
- MiniMax: `*.minimax.io`, `*.minimaxi.com`
- Xiaomi MiMo: `*.xiaomimimo.com`
- DeepSeek: `*.deepseek.com`
- Google Gemini: `generativelanguage.googleapis.com`
- xAI / Grok: `*.x.ai`, exact host `cli-chat-proxy.grok.com` (OAuth subscription lookup at
  `/v1/user?include=subscription`)

Operators can narrow or extend the allowed egress hosts with `PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS` (see [Official Exit Verification](OFFICIAL_VERIFICATION.md#restricting-egress)); the setting is local-only and cannot be overridden by Platform. Wildcard `*` is not supported; use explicit hosts or domain patterns such as `.example.com` / `*.example.com`.

## Supported Local Authorization Sources

- Codex `auth.json`
- Claude Code local credentials
- Manual OAuth token JSON
- Claude OAuth authorization code flow
- Codex device code / OAuth flow
- xAI/Grok device code / OAuth flow

Browser cookie/session import is intentionally unsupported. Provider Node does not scan browser cookie databases and does not read browser safe-storage secrets.

## Local Console Security

The local console protects write APIs with:

- loopback Host allowlist to reduce DNS rebinding risk;
- CSRF token required on all mutating `/api/*` requests;
- Origin/Referer checks for browser writes;
- JSON content-type requirement for mutating API calls.

CLI commands fetch the local CSRF token from `/api/csrf` before making writes.

## Local Config Security

Secret fields in the config (`providerNodeSecret`, `upstream.apiKey`, OAuth `accessToken` / `refreshToken` / `idToken`) are encrypted at rest with AES-256-GCM under the `enc:v1:` prefix. The key is taken from `PROVIDER_NODE_MASTER_KEY` (derived via scrypt) if set, otherwise a generated `<config>.json.key` file (32 random bytes, mode `0600`). The config file itself is written `mode 0600` inside a `0700` directory so other local users on a shared host cannot read it. See [`.env.example`](../.env.example) for `PROVIDER_NODE_MASTER_KEY` guidance.

## Common Commands

```bash
wokey-node
wokey-node add
wokey-node bind --value bind_...
wokey-node restart
wokey-node update
wokey-node status
wokey-node doctor
```

## Development

```bash
npm install
npm run dev
```

Use a local config while testing:

```bash
PROVIDER_CONFIG_PATH=./data/provider-node.json npm run dev
```

## Verification

```bash
npm run verify
```
