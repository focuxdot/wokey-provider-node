# Changelog

All notable changes to Wokey Provider Node are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.80]

### Added
- Report bounded credential-channel health metrics to the Platform without
  exposing credential identifiers.

### Changed
- Omit credential-channel metrics from normal heartbeats, report them while
  degraded or reconnecting, when liveness timeout counts change, and once on
  recovery so the Platform does not retain stale abnormal state.

## [0.1.79]

### Fixed
- Reconcile credential-scoped data channels that stop receiving Platform
  activity without delivering a WebSocket close event, then reconnect them
  through the existing bounded handshake queue.
- Drive independent ping/pong liveness probes so channel recovery does not
  depend on the Platform heartbeat interval, while enforcing at least three
  probe periods before declaring a timeout.

### Added
- Expose credential-channel readiness, reconnect backlog, and liveness timeout
  counters in the local status response for rollout verification.

## [0.1.78]

### Added
- Report Provider Node auto-upgrade receipt, skip, failure, rollback, and
  verification status to the Platform with the rollout identity and durable
  post-restart replay.

### Changed
- Let the Platform own the total credential data-channel plan while the node
  retains a bounded concurrent-handshake limit to establish large plans in
  controlled batches.

## [0.1.77]

### Fixed
- Keep first-byte and non-streaming requests on the existing five-minute
  deadline while allowing an active streaming response to remain idle for up
  to 30 minutes between response bytes.

## [0.1.76]

### Fixed
- Persist the validated Node.js interpreter before the macOS package starts
  its LaunchAgent, so installations using nvm, fnm, Volta, or Conda do not
  fail the first health check.
- Discover supported version-managed Node.js runtimes during direct `.pkg`
  installation using bounded paths, console-user execution, and probe
  timeouts; also repair the user data directory and node hint permissions.

## [0.1.75]

### Fixed
- Allow Jimeng / Dreamina Image 4.0 results to download from signed
  `*.byteimg.com` URLs through the official exit.

## [0.1.68]

### Added
- Allow Jimeng / Dreamina image uploads to use the official
  `*.bytedanceapi.com` root domain and future subdomains.

### Fixed
- Classify reference-media upload DNS and transport failures as retryable,
  reset the durable submission receipt safely, and permit a clean resubmit
  instead of persisting a terminal upstream task failure.

### Security
- Update the transitive `fast-uri` dependency to `3.1.5` to address its host
  confusion advisory.

## [0.1.67]

### Fixed
- Allow completed Jimeng / Dreamina videos to download from signed
  `*.vlabvod.com` media URLs, preventing successful upstream jobs from being
  left in repeated `jimeng_cli_process_failed` polling states.
- Preserve the CLI's default aspect-ratio behavior when Platform omits the
  optional `ratio` field.
- Report privacy-safe CLI failure diagnostics (exit status plus stderr byte
  count and SHA-256) without exposing raw stderr or credential material.

## [0.1.54]

### Added
- Capture the Jimeng account ID, account name, VIP level, credit balance, and
  CLI permission during authorization so the Platform can identify shared
  accounts without exposing credential secrets.

### Fixed
- Preserve Jimeng account metadata when the CLI refreshes credentials during
  video generation.
- Reuse and safely restore native Dreamina credentials across macOS, Windows,
  and Linux authorization flows, including malformed-state recovery.

## [0.1.50]

### Fixed
- Preserve structured OAuth and Platform failures instead of collapsing known
  errors into `internal_error`, including upstream status, retryability, and a
  request ID for unexpected failures.
- Classify authorization DNS, connection timeout, TLS, rate-limit, region,
  invalid-response, and service-availability failures with stable error codes.
- Show actionable English and Chinese console guidance for node binding,
  authorization, Platform connectivity, credential identity, and local auth
  file failures.
- Do not treat a structured Codex 403 such as
  `unsupported_country_region_territory` as a still-pending device flow.

## [0.1.49]

### Fixed
- Allow Claude browser-session bootstrap requests to reach `claude.ai` through
  the default official-exit allowlist.

## [0.1.48]

### Added
- Negotiated `buffered_v1` early data for official-exit binary tunnels, with a
  64 KiB pre-connect limit, ordered flush, cancellation cleanup, and byte
  diagnostics.

### Fixed
- Allow Qwen DashScope and Token Plan endpoints through the official-exit
  allowlist with `*.aliyuncs.com`.

## [0.1.47]

### Added
- Dual-stack official-exit transport with explicit binary-frame negotiation,
  credit-based backpressure, wire/payload byte accounting, and bounded 1 MiB
  WebSocket messages while retaining JSON compatibility.
- Drain notice/ack coordination so auto-upgrades wait for the platform to stop
  assigning work and for the node's in-flight requests to finish.

### Changed
- Local credential discovery now persists privacy-safe binding references and
  only displays credentials that were authorized or imported on this node.
- The local console uses the Deep Current visual treatment and clearer setup,
  credential, and xAI/Grok guidance.

### Fixed
- Linux installation now keeps apt and needrestart non-interactive, avoids
  restarting unrelated services, and falls back to the tarball when the active
  Node.js runtime is not managed by dpkg.
- Platform-input and upstream-output backpressure now have independent timeout
  tracking, preventing activity on one direction from hiding a stalled peer.

## [0.1.37]

### Fixed
- Fixed the relay endpoint failover never alternating. A single failed connect
  emits both `error` and `close`, so the reconnect handler ran twice and toggled
  the direct↔fallback choice twice (net zero), leaving the bridge stuck retrying
  the same unreachable endpoint. The endpoint now flips exactly once per failed
  attempt, so a node whose current endpoint becomes unreachable actually moves to
  the other one. (Binding still seeds the right endpoint, so this only affected
  runtime failover after the initial connect.)

## [0.1.36]

### Changed
- The node now remembers which platform endpoint is reachable. When bind reaches
  the platform only via the fallback endpoint, it records that preference so the
  WebSocket relay connects straight to the fallback instead of trying the dead
  direct endpoint first on every (re)connect. The bridge also persists whichever
  endpoint it settles on, so the preference survives restarts and still recovers
  to the direct endpoint if it becomes reachable again.

## [0.1.35]

### Fixed
- Bound the platform connect/upgrade with a 10s handshake timeout. Previously a
  blocked or blackholed primary endpoint (firewall silently dropping packets)
  could hang on the OS TCP timeout for ~2 minutes before the bridge flipped to
  the fallback endpoint, so a node with a reachable fallback still looked
  permanently disconnected. It now flips within seconds.

## [0.1.34]

### Added
- Provider link fallback for networks that block the bare origin IP but not the
  domain (e.g. some mainland China ISPs). The bridge and the bind path retry
  through a CDN-proxied endpoint (`node.wokey.ai` → `nodey.wokey.ai`) when the
  direct one is unreachable, and stick to whichever endpoint connects. This is a
  runtime fallback only — the direct host remains the persisted source of truth.
- A 30s WebSocket keepalive ping so the relay survives CDN idle timeouts.

### Changed
- Binding now reports `platform_unreachable` (with a clear localized console
  message) when neither the direct nor the fallback endpoint can be reached,
  instead of a generic `internal_error`. Genuine binding-code rejections are
  still surfaced verbatim.

## [0.1.33]

### Fixed
- The background service could fail to start when Node.js was installed only
  through a version manager (nvm/fnm/volta): the service runs with a minimal
  PATH (launchd on macOS, systemd `--user` on Linux, Scheduled Task on Windows)
  that does not include the user's interactive shell environment, so `serve`
  could not find the `node` the CLI had resolved, and it crash-looped while the
  service still reported "loaded". The launchers now record the resolved
  interpreter on `restart`/`install`/`start` and reuse it for the service,
  closing the gap. Set `PROVIDER_NODE_NODE` to override.
- `wokey-node restart`/`start` no longer report "started" before verifying the
  console is reachable. They now poll `http://<host>:<port>/api/status` (up to
  `PROVIDER_CONSOLE_READY_TIMEOUT`, default 15s); on success they print the
  console URL, and on failure they print the tail of the service error log and
  exit non-zero instead of falsely claiming success.

### Added
- `wokey-node logs` on macOS, tailing the service stdout/stderr logs (the verb
  was already documented and available on Linux/Windows but missing on macOS).

## [0.1.32]

### Changed
- Local credential auto-scan in the node console is paused (UI-only). The
  Credentials section no longer scans for or imports on-machine Codex /
  Claude Code OAuth files, and the "Scan credentials" button is hidden;
  onboarding goes through manual add (browser OAuth, device code, or pasting a
  token). This removes the confusing detect-but-can't-import states (credentials
  living in the OS credential store, Claude Desktop vs Claude Code) and the
  post-import refresh-token rotation problem. Local-detect server endpoints are
  unchanged; re-enable by flipping `LOCAL_AUTH_SCAN_ENABLED` in the console.

## [0.1.31]

### Changed
- OAuth credential authorization no longer self-refreshes the access token on
  the node. Token validity and account identity are established platform-side
  at write time (through the credential's bound provider node, fingerprint-
  matched), so a node-side refresh — which would egress the node's own TLS
  fingerprint, inconsistent with the credential's rendered inference identity —
  is no longer performed. Freshly minted tokens (device-code / code-exchange)
  and CLI-maintained `~/.codex/auth.json` tokens are unaffected.

### Removed
- The unused `POST /api/oauth/codex/refresh` and `POST /api/oauth/anthropic/refresh`
  console endpoints, plus the now-dead token-refresh helpers.

## [0.1.30]

### Added
- Auto-upgrade: platform pushes `platform.upgrade_available` via WebSocket;
  node drains in-flight requests, spawns the existing update command, and lets
  the OS supervisor restart the new version. Crash-loop detection (3-strike
  rollback) and 60-second stability verification are built in. Opt out with
  `autoUpdate: false` in `provider-node.json`.
- Official-exit domain allowlist widened from exact subdomains to wildcard
  apex domains (`*.openai.com`, `*.anthropic.com`, `*.claude.com`, etc.) so
  vendor OAuth and auxiliary endpoints are covered automatically.
  `googleapis.com` and `aliyuncs.com` remain pinned to exact subdomains to
  avoid over-permitting.

## [0.1.29]

### Added
- The one-line installers now install Node.js 20+ automatically when it is
  missing or too old, instead of aborting with a "Node.js 20 or newer is
  required" error. Coverage spans all supported platforms: winget or the
  official MSI on Windows (x64/arm64/x86); Homebrew or the official universal
  `.pkg` on macOS; NodeSource (apt), `apk` on Alpine, or the official prebuilt
  binaries on Linux (x64/arm64/armv7l/ppc64le/s390x). When automatic
  installation is unavailable, the installer prints a clear manual-install
  message.

## [Unreleased]

### Added
- Operator egress allowlist for the official-exit tunnel
  (`PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS`); defaults to the supported official
  vendor host list in `src/shared/official-exit-vendors.ts`; unrestricted `*`
  egress is not supported.
- Cosign keyless signing of release `checksums.txt`; installers verify the
  signature when `cosign` is present.
- Local console served from a built asset; uniform `{ ok, error }` API envelope
  via a global error handler.
- Biome lint + format, CI lint gate, and HTTP integration tests.

### Changed
- At-rest config is written `0600`; the env master key is derived via scrypt.
- Release installers no longer require users to preinstall `cosign`; SHA-256
  package verification remains mandatory, and `cosign` provenance verification
  runs automatically when available or when strict mode is requested.
- Provider bridge WebSocket connections now send `x-provider-node-id` in
  addition to the `node_id` query parameter, matching the production Platform
  authentication path while retaining log correlation compatibility.
- Provider bridge WebSocket connections no longer append `node_id` to the URL;
  node identity is sent only via headers to avoid putting it in URL logs.

### Security
- Config secrets remain encrypted (AES-256-GCM) at rest; browser cookie/session
  import is unsupported.
