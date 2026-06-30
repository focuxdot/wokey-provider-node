# Windows Installer

The Windows package installs Wokey Provider Node as a per-user runtime managed by a Scheduled Task.

## Installed Files

- `%LOCALAPPDATA%\WokeyProviderNode\app`
- `%LOCALAPPDATA%\WokeyProviderNode\bin\wokey-node.ps1`
- `%LOCALAPPDATA%\WokeyProviderNode\bin\wokey-node.cmd`
- `%APPDATA%\Wokey Provider Node\provider-node.json`
- Scheduled Task: `WokeyProviderNode`

## Build

```bash
npm run package:windows
```

Artifacts are written under `release/windows/`.

## Install From Release

Run in PowerShell:

```powershell
irm https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.ps1 | iex
```

The installer downloads `checksums.txt`, verifies the package SHA-256, installs the zip payload, adds the node wrapper directory to the user `Path`, registers the Scheduled Task, and starts Provider Node. If `cosign` is installed, it also verifies official release provenance. To require provenance verification, see [Verifying a Release](../README.md#verifying-a-release).

### Node.js runtime

Provider Node runs on Node.js 20+. If a suitable Node.js is not already present, the installer installs the latest LTS automatically — via `winget` when available, otherwise the official Node.js MSI from nodejs.org (covering x64, arm64, and 32-bit hosts). No manual Node.js setup is needed.

If automatic installation is blocked (e.g. restricted corporate machine, no network), install Node.js 20+ yourself, then rerun the installer:

```powershell
winget install OpenJS.NodeJS.LTS
# or download from https://nodejs.org
```

## Troubleshooting

```powershell
wokey-node doctor
wokey-node status
wokey-node logs
wokey-node open
```

To remove the Scheduled Task while keeping user data:

```powershell
wokey-node uninstall-service
```
