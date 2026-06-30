# Docker Deployment

[中文版](DOCKER.zh-CN.md)

Docker deployment does not require Node.js on the host. Provider Node runs
inside the container, and Docker manages the background process.

## Quick Install

Run this on the server:

```bash
git clone https://github.com/focuxdot/wokey-provider-node.git
cd wokey-provider-node
docker compose up -d
```

This uses the repository `compose.yaml`, pulls the official image, and starts
Provider Node in the background. For long-running deployments, pin the image to
a version tag:

```bash
WOKEY_PROVIDER_NODE_IMAGE=ghcr.io/focuxdot/wokey-provider-node:vX.Y.Z docker compose up -d
```

## Open The Console

If your browser is on the same machine that runs Docker, open:

```text
http://127.0.0.1:16888
```

If Docker runs on a remote server, create an SSH tunnel from your computer:

```bash
ssh -L 16889:127.0.0.1:16888 user@server
```

Then open this URL on your computer:

```text
http://127.0.0.1:16889
```

Do not expose `16888` directly to the public internet. The default compose file
binds the console to the server loopback address only.

## Bind And Authorize

You can bind and authorize from the console. On a headless server, use the CLI:

```bash
docker compose exec provider-node wokey-node bind --value bind_...
docker compose exec provider-node wokey-node add
```

Check status:

```bash
docker compose ps
docker compose exec provider-node wokey-node status
```

## Common Maintenance

View logs:

```bash
docker compose logs -f provider-node
```

Restart:

```bash
docker compose restart provider-node
```

Upgrade the official image:

```bash
docker compose pull
docker compose up -d
```

Stop:

```bash
docker compose stop
```

## Where Data Is Stored

Node config and authorization data are stored in this Docker volume:

```text
wokey-provider-node-data
```

Do not delete this volume during upgrades. If it is deleted, you may need to bind
and authorize the node again.

Back up the volume:

```bash
docker run --rm \
  -v wokey-provider-node-data:/data:ro \
  -v "$PWD":/backup \
  busybox tar czf /backup/wokey-provider-node-data.tgz -C /data .
```

Restore the volume:

```bash
docker compose down
docker run --rm \
  -v wokey-provider-node-data:/data \
  -v "$PWD":/backup \
  busybox sh -c 'cd /data && tar xzf /backup/wokey-provider-node-data.tgz'
docker compose up -d
```

## Build From Source

Most users do not need a source build. Use it only when testing local changes,
building your own image, or running before an official image is available:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Source builds run `npm ci` and build on the server, so the first run can be much
slower.

## Credential Files

Docker does not automatically see host files such as Codex `auth.json` or Claude
Code local credentials. Prefer the console flow, device code flow, or manual
token JSON flow:

```bash
docker compose exec provider-node wokey-node add
docker compose exec provider-node wokey-node login codex
docker compose exec provider-node wokey-node paste token --vendor openai --file /data/token.json
```

If you intentionally import a host credential file, mount only that exact file
or directory. Do not mount the whole home directory into the container.

## Image Verification

Official images are published at:

```text
ghcr.io/focuxdot/wokey-provider-node
```

Version tags match GitHub Release tags. Release images are signed with keyless
cosign provenance by GitHub Actions.

Verify an image signature:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/focuxdot/wokey-provider-node:vX.Y.Z
```

## Troubleshooting

```bash
docker compose ps
docker compose logs -f provider-node
docker compose exec provider-node wokey-node doctor
docker compose exec provider-node wokey-node status
curl http://127.0.0.1:16888/api/status
```

If `curl` works on the server but your computer cannot access the console, use
SSH port forwarding instead of exposing the console publicly.
