# macOS Installer

The macOS package installs Wokey Provider Node as a LaunchAgent-backed local daemon.

## Installed Files

- `/usr/local/wokey-provider-node/bin/provider-node`
- `/usr/local/wokey-provider-node/bin/bootstrap.mjs`
- `/usr/local/bin/wokey-node`
- `/Library/LaunchAgents/ai.wokey.provider-node.plist`
- `~/Library/Application Support/Wokey Provider Node/provider-node.json`
- `~/Library/Application Support/Wokey Provider Node/runtime/versions/<version>`
- `~/Library/Application Support/Wokey Provider Node/runtime/current`

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

Provider Node runs on Node.js 22.22.2+. If a suitable Node.js is not already present, the installer installs it automatically — via Homebrew when available, otherwise the official universal Node.js `.pkg` from nodejs.org (Intel and Apple Silicon). To set it up yourself instead, install the current Node.js LTS from [nodejs.org](https://nodejs.org) (or `brew install node`) before running the installer.

## Troubleshooting

```bash
wokey-node doctor
wokey-node status
wokey-node restart
curl http://127.0.0.1:16888/api/status
```

## Update

For an existing node that still uses the old system-level runtime, run the
one-time migration entrypoint as the same macOS user that runs Provider Node:

```bash
curl -fsSL https://raw.githubusercontent.com/focuxdot/wokey-provider-node/main/packaging/migrate-macos-v0.1.71.sh | bash
```

This entrypoint is pinned to the v0.1.71 migration release. It downloads that
release's `install.sh` and `checksums.txt` and verifies the installer's SHA-256
before executing it. macOS asks for administrator authorization once during
this migration; later releases do not include or need this migration script.

After migration, normal manual updates use:

```bash
wokey-node version
wokey-node update
wokey-node status
```

The first migration from an older installation uses the `.pkg` once and macOS
may request an administrator password because the stable launcher and
LaunchAgent live in system locations. Later updates do not reinstall the
package and do not use `sudo`.

The updater verifies the release's Sigstore bundle, GitHub Actions workflow
identity, transparency-log proof, signed checksum, and the hash sent by the
Wokey Platform. It stages the new runtime in the user's data directory, swaps
`runtime/current` atomically, then restarts the LaunchAgent. The previous
runtime stays available for local rollback. A new runtime is marked stable
after 60 seconds; three failed starts roll back before the broken runtime is
launched again.

## Uninstall

Remove the runtime while keeping local data:

```bash
wokey-node uninstall
```

Remove the runtime and local data:

```bash
wokey-node uninstall --purge
```

The `Uninstall.command` bundled in the DMG performs the non-purge removal.
