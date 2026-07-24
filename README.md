# Wokey Provider Node

> Turn unused AI subscription capacity into supply — and earn from every routed call.

[![Release](https://img.shields.io/github/v/release/focuxdot/wokey-provider-node?label=release)](https://github.com/focuxdot/wokey-provider-node/releases)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Official Exit](https://img.shields.io/badge/official--exit-encrypted%20egress-6230eb)](docs/OFFICIAL_VERIFICATION.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

Run a node on your own machine to share idle **Claude / Codex (OpenAI) / Zhipu / Kimi** (and more) subscription capacity through Wokey. **You earn from every successfully routed call.** Business policy, billing, and vendor request construction stay on Wokey Platform — the node is just your local onboarding console and a restricted network exit.

[Install](#quick-install) · [Docker](docs/DOCKER.md) · [First run](#first-run) · [Is it safe?](#is-it-safe) · [How it works](#how-it-works) · [Egress allowlist](#egress-allowlist) · [Commands](#common-commands) · [Verify a release](#verifying-a-release) · [Docs](#documentation)

[中文版](README.zh-CN.md) · [Provider onboarding guide](https://wokey.ai/docs/provider) · [Official website](https://wokey.ai)

---

## Why run it

- **Earn from idle capacity.** If your Claude, Codex, or other AI subscription is regularly underused, the node connects that spare capacity to Wokey and you get paid per successfully routed call.
- **No public port, no servers to run.** The node connects *outbound* to Wokey Platform — you never expose an inbound port or operate infrastructure.
- **It stays online only when you want.** Going offline never affects your account; you simply earn nothing for that idle time.

…and, by design, it deliberately does **not** read your prompts, scrape your browser, or decide routing/billing. See [Is it safe?](#is-it-safe).

## Trust, but verify

You don't have to take any of this on faith:

- **It's open source** — read every line in this repo.
- **The installer verifies SHA-256** of each artifact against `checksums.txt` (optional `cosign` provenance verification too — see [Verifying a release](#verifying-a-release)).
- **The node can only reach official vendor domains** — the allowlist is source code, not a remote setting. See [Egress allowlist](#egress-allowlist).
- **Check it yourself anytime** with `wokey-node doctor` and `wokey-node status`.

## Quick Install

macOS / Linux:

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.ps1 | iex
```

Node.js 20+ is required, and the installer installs it automatically when it is missing (winget or the official package on Windows, Homebrew or the official package on macOS, the official prebuilt binaries on Linux). The installer downloads `checksums.txt` and verifies the downloaded artifact's SHA-256 before installing. If `cosign` is already installed, it also verifies official release provenance automatically; installation still works without `cosign`.

Then open the local console:

```text
http://127.0.0.1:16888
```

## First Run

1. Install Provider Node.
2. Open the local console at `http://127.0.0.1:16888`, or run `wokey-node`.
3. Open the Wokey Provider page from the console and sign in.
4. Bind the node automatically, or paste a `bind_...` binding code.
5. Add an authorization credential from a detected local source or a guided OAuth flow.
6. Confirm it worked: the authorized account now shows in the local console — and on the Wokey Provider page on the website. (On a headless server, run `wokey-node status` instead.)

Remote Linux servers can use the CLI path without exposing the console publicly:

```bash
wokey-node
wokey-node bind --value bind_...
wokey-node add
wokey-node list
wokey-node import 1
wokey-node login codex
wokey-node paste token --vendor openai --file ./token.json
```

> New to this? The step-by-step [provider onboarding guide](https://wokey.ai/docs/provider) walks through install → bind → authorize with success checks at each step.

## Is it safe?

Provider Node runs on your machine, but it is intentionally narrow. In plain terms:

**What it does**

- Binds your machine to your Wokey account.
- Handles local onboarding, authorization, and diagnostics.
- Opens *outbound* connections requested by the bound Platform.
- Relays encrypted official-exit traffic to approved vendor hosts.
- Reports local health and capacity signals.

**What it cannot do**

- Read your prompts, model responses, or vendor authorization headers — official-exit traffic stays inside the vendor's TLS; the node relays bytes and never terminates TLS.
- Decide routing, billing, entitlement (account permissions), quota, model mapping, or settlement — those live on Wokey Platform.
- Import browser cookies or browser-stored secrets — browser scraping is unsupported, by design.
- Widen its own network exit remotely — the allowlist is read only from local source/environment, so Platform cannot broaden it.

Sensitive local config fields are encrypted at rest under the `enc:v1:` prefix. The encryption key comes from `PROVIDER_NODE_MASTER_KEY` when set, or from a generated local key file beside the config.

For the full technical statement, see [Safety boundary](#safety-boundary) and [Egress allowlist](#egress-allowlist).

## How It Works

| Part | Runs where | Responsibility |
| --- | --- | --- |
| Wokey Platform | Wokey infrastructure | Accounts, routing, billing, credential custody, vendor request construction, policy, settlement |
| Provider Node | Your machine | Local console, node binding, credential onboarding, outbound bridge, restricted network exit |
| Vendor API | Official vendor host | Receives the HTTPS request Platform sends through the Provider Node exit |

Official-exit request flow:

```text
Wokey Platform -> outbound WebSocket -> Provider Node -> TCP socket -> vendor host
```

Platform constructs the vendor HTTPS request and performs TLS *through* the node's TCP socket. Provider Node opens the socket and relays bytes; it does not terminate vendor TLS, so it never sees request or response contents.

## Local Authorization

Supported local authorization paths:

- Codex `auth.json`
- Claude Code local credentials
- Codex device-code / OAuth flow
- Claude OAuth authorization-code flow
- xAI/Grok one-click device-code / OAuth flow
- Manual OAuth token JSON

During onboarding you explicitly authorize or import a credential bundle. The selected bundle is uploaded to Wokey Platform's encrypted credential store so Platform can construct official vendor requests on your behalf.

The local console lists only credentials authorized or imported on this node.
Provider-owned credentials assigned to the node for routing remain private and
do not appear as local credentials.

Browser cookie, browser session, and browser safe-storage (OS keychain) secret import is intentionally unsupported. Provider Node does not scan browser cookie databases.

## Egress Allowlist

This is the single most important safety property, so it is enforced in source, not configuration: by default Provider Node only allows official-exit connections to the official domains of currently supported vendors. The public source of truth:

- [src/shared/official-exit-vendors.ts](src/shared/official-exit-vendors.ts)
- [Official Exit Verification](docs/OFFICIAL_VERIFICATION.md#restricting-egress)

| Vendor | Default hosts |
| --- | --- |
| OpenAI / Codex | `*.openai.com`, `*.chatgpt.com` |
| Anthropic / Claude | `*.anthropic.com`, `*.claude.com` |
| Qwen | `dashscope.aliyuncs.com`, `dashscope-us.aliyuncs.com` |
| Zhipu AI | `*.bigmodel.cn`, `*.z.ai` |
| Moonshot / Kimi | `*.kimi.com`, `*.moonshot.ai`, `*.moonshot.cn` |
| MiniMax | `*.minimax.io`, `*.minimaxi.com` |
| Xiaomi MiMo | `*.xiaomimimo.com` |
| DeepSeek | `*.deepseek.com` |
| Google Gemini | `generativelanguage.googleapis.com` |
| xAI / Grok | `*.x.ai`, `*.grok.com` |

You can narrow or extend the local egress host list with `PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS`. This setting is read only from the local environment, so Platform cannot widen it remotely. Wildcard `*` is not supported; use explicit hosts or domain patterns such as `.example.com` / `*.example.com`.

For xAI OAuth credentials, `*.grok.com` allows the current Grok CLI profile host and
future official Grok subdomains without requiring another Provider Node release.

## Safety Boundary

Provider Node is provider-side software, but it is not the source of truth for production business policy.

It can:

- bind a provider-owned machine to Wokey;
- manage local onboarding and diagnostics;
- open outbound connections requested by the bound Platform;
- relay encrypted official-exit traffic;
- report local health and saturation signals.

It cannot:

- decide routing, billing, entitlement, quota, model mapping, or settlement;
- terminate vendor TLS in official-exit mode;
- read user prompts, model responses, or vendor authorization headers;
- import browser cookies or browser safe-storage secrets;
- widen the local operator's egress allowlist remotely.

## Common Commands

| Command | Use |
| --- | --- |
| `wokey-node` | Open the interactive local CLI menu |
| `wokey-node open` | Open the local console in a browser, where supported |
| `wokey-node bind --value bind_...` | Bind this node with a Provider page binding code |
| `wokey-node add` | Add a credential through the guided CLI flow |
| `wokey-node list` | List importable local authorization sources |
| `wokey-node import 1` | Import a detected credential candidate |
| `wokey-node login codex` | Start Codex device-code authorization |
| `wokey-node paste token --vendor openai --file ./token.json` | Paste authorization material manually |
| `wokey-node status` | Show local, binding, bridge, and credential status |
| `wokey-node doctor` | Run diagnostics |
| `wokey-node restart` | Restart the local service |
| `wokey-node update` | Re-run the latest release installer |
| `wokey-node logs` | Show service logs, where supported |

## Verifying A Release

Official releases publish `checksums.txt`, `checksums.txt.sig`, and `checksums.txt.pem`. Installers always verify each artifact's SHA-256 against `checksums.txt`. If `cosign` is installed, they also verify the GitHub Actions keyless signature over `checksums.txt` to confirm the release came from the official release workflow.

`cosign` is not required for quick installation. To require provenance verification, install `cosign` first and run:

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1 bash
```

Windows PowerShell:

```powershell
$env:WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE = "1"
irm https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.ps1 | iex
```

Manual verification example:

```bash
cosign verify-blob \
  --certificate checksums.txt.pem \
  --signature checksums.txt.sig \
  --certificate-identity-regexp '^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  checksums.txt
```

## Configuration

Runtime configuration is provided through environment variables. Copy [`.env.example`](.env.example) to `.env.local` for local development; `npm start` loads `.env.local` automatically.

Common settings include local console host/port, config path, local encryption master key, Platform host allowlist, official-exit egress allowlist, and log level.

## Development

```bash
npm install            # install dependencies
npm run dev            # start the local console
npm run verify         # run full verification (lint, types, tests)
```

Use a local config while testing:

```bash
PROVIDER_CONFIG_PATH=./data/provider-node.json npm run dev
```

## Packaging

```bash
npm run package:provider-node   # build all supported packages
npm run release:checksums       # generate release checksums
```

## File Structure

```text
wokey-provider-node/
├── src/provider-node/          # daemon, console API, bridge, OAuth, local config
├── src/shared/                 # protocol, crypto, ids, vendor allowlist
├── web/console/                # local console HTML, CSS, client JS, bundled fonts
├── packaging/                  # macOS, Linux, Windows wrappers and installers
├── scripts/                    # build, package, checksum, OSS-boundary checks
├── docs/                       # runtime, installer, verification, maintainer docs
├── Dockerfile
├── compose.yaml
├── compose.build.yaml
├── .github/workflows/release.yml
├── README.md
└── LICENSE
```

## Documentation

- [Provider Node](docs/PROVIDER_NODE.md)
- [macOS Installer](docs/MACOS_INSTALLER.md)
- [Linux Installer](docs/LINUX_INSTALLER.md)
- [Windows Installer](docs/WINDOWS_INSTALLER.md)
- [Docker Deployment](docs/DOCKER.md)
- [Official Exit Verification](docs/OFFICIAL_VERIFICATION.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
