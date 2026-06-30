# macOS Installer

The macOS package installs Wokey Provider Node as a LaunchAgent-backed local daemon.

## Installed Files

- `/usr/local/wokey-provider-node/app`
- `/usr/local/wokey-provider-node/bin/provider-node`
- `/usr/local/bin/wokey-node`
- `/Library/LaunchAgents/ai.wokey.provider-node.plist`
- `~/Library/Application Support/Wokey Provider Node/provider-node.json`

## Build

```bash
npm run package:macos
```

Artifacts are written under `release/macos/`.

## Install From Release

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | bash
```

The installer downloads `checksums.txt`, verifies the package SHA-256, then runs the macOS installer. If `cosign` is installed, it also verifies official release provenance. To require provenance verification, see [Verifying a Release](../README.md#verifying-a-release).

### Node.js runtime

Provider Node runs on Node.js 20+. If a suitable Node.js is not already present, the installer installs it automatically — via Homebrew when available, otherwise the official universal Node.js `.pkg` from nodejs.org (Intel and Apple Silicon). To set it up yourself instead, install Node.js 20+ from [nodejs.org](https://nodejs.org) (or `brew install node`) before running the installer.

## Troubleshooting

```bash
wokey-node doctor
wokey-node status
wokey-node restart
curl http://127.0.0.1:16888/api/status
```

To remove the runtime, use the `Uninstall.command` bundled in the DMG or remove the installed paths above. User config is intentionally kept unless deleted manually.
