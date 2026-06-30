# Contributing

Thanks for your interest in Wokey Provider Node. This repository is the
installable node software only — Wokey Platform, routing, billing, and the
credential vault are not part of it.

## Prerequisites

- Node.js 20 or newer (`node --version`).
- A POSIX shell for the packaging scripts (macOS/Linux); Windows packaging runs
  in PowerShell.

## Local development

```bash
npm install        # install dependencies
npm run dev        # start the local console with live reload (tsx watch)
```

Open the console at <http://127.0.0.1:16888>. By default the node runs in `mock`
upstream mode with a `dev` provider id — no Platform connection is required to
explore the console.

Useful environment variables (see [`.env.example`](.env.example) for the full
list): `PROVIDER_CONSOLE_PORT`, `PROVIDER_CONFIG_PATH`, `LOG_LEVEL`. Copy
`.env.example` to `.env.local` for `npm start`.

## Quality gates

Run before opening a pull request:

```bash
npm run verify     # lint + build + test + OSS-boundary audit + npm audit
```

Individual steps:

```bash
npm run lint       # Biome lint
npm run format     # Biome format (writes changes)
npm test           # Vitest
npm run build      # tsc + build info
npm run audit:oss  # public trust-boundary checks (see below)
```

CI runs the same gates on every pull request.

## Project layout

```text
src/shared/         wire protocol, crypto, env, vendor compatibility (no node-only imports)
src/provider-node/  the daemon: console server, outbound bridge, official-exit relay,
                    config, OAuth/credential handling
packaging/          macOS/Linux/Windows installers + service definitions
scripts/            build, packaging, release, and the OSS-boundary audit
tests/              Vitest unit tests
```

Maintainer publishing notes live in [docs/MAINTAINER_RELEASE.md](docs/MAINTAINER_RELEASE.md).

## Trust boundary (must preserve)

The OSS-boundary audit (`scripts/audit-oss-boundary.sh`, run by `npm run verify`)
fails CI if these are violated, so keep them in mind:

- Do not add browser cookie/session import paths.
- Do not log prompt bodies, response bodies, OAuth tokens, cookies, or
  authorization headers.
- Keep local console write APIs protected by CSRF checks.
- Keep Platform internals out of this repository (no internal hostnames, infra
  topology, or Platform-only subsystem vocabulary in code, comments, or tests).
- During official-exit, Provider Node relays encrypted bytes only — it must not
  terminate vendor TLS or read prompts/responses/headers.

## Pull requests

- Keep changes focused; update tests and docs for any behavior change.
- Use clear commit messages; describe the user-visible effect in the PR.
- Security issues: do not open a public issue — see [SECURITY.md](SECURITY.md).
