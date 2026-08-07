# Linux Installer

Linux Provider Node is a server-first runtime built around `systemd --user`.

## Installed Files

- `/opt/wokey-provider-node/app`
- `/opt/wokey-provider-node/bin/provider-node`
- `/usr/local/bin/wokey-node`
- `${XDG_CONFIG_HOME:-~/.config}/wokey-provider-node/provider-node.json`
- `${XDG_CONFIG_HOME:-~/.config}/systemd/user/wokey-provider-node.service`

## Build

```bash
npm run package:linux
```

Artifacts are written under `release/linux/`.

## Install From Release

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | bash
```

The installer downloads `checksums.txt`, verifies the package SHA-256, then installs a `.deb` package or tarball depending on the host. If `cosign` is installed, it also verifies official release provenance. To require provenance verification, see [Verifying a Release](../README.md#verifying-a-release).

### Node.js runtime

Provider Node runs on Node.js 20+. If a suitable Node.js is not already present, the installer installs it automatically — via `apk` on Alpine/musl, otherwise the official prebuilt Node.js binaries from nodejs.org unpacked into `/usr/local` (x64, arm64, armv7l, ppc64le, s390x). Automatic install uses `sudo`, the same as the package install. To set it up yourself instead, install Node.js 20+ from [nodejs.org](https://nodejs.org) before running the installer.

## Remote Console Access

The console binds to `127.0.0.1`. For a remote Linux node, use SSH forwarding:

```bash
ssh -L 16889:127.0.0.1:16888 user@host
```

Then open `http://127.0.0.1:16889`.

## Troubleshooting

```bash
wokey-node doctor
wokey-node status
journalctl --user-unit wokey-provider-node.service -f
curl http://127.0.0.1:16888/api/status
```

## Update

Run the update over SSH or in a local terminal as the same Linux user that runs
Provider Node:

```bash
wokey-node version
wokey-node update
wokey-node status
```

The updater downloads the latest release installer, verifies the artifact,
reinstalls the package or tarball, and restarts the user service. It keeps the
node binding and local data. Package installation can require `sudo`; remote
automatic updates therefore require non-interactive sudo, while a manual
`wokey-node update` can prompt in an interactive terminal.

If the command is not on `PATH`, use:

```bash
/usr/local/bin/wokey-node update
```

## Uninstall

Remove the background service and runtime while keeping local data:

```bash
wokey-node uninstall
```

The command automatically detects whether Provider Node was installed from the
`.deb` package or tarball and removes the matching runtime files.

Remove the runtime and local node data, including the node binding, credentials,
and local settings:

```bash
wokey-node uninstall --purge
```

The default command intentionally keeps local node data in
`${XDG_CONFIG_HOME:-~/.config}/wokey-provider-node`. Package removal may request
administrator authorization through `sudo`.
