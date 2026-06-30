import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { getEnv, getEnvNumber } from '../shared/env.js';
import type { PlatformCredentialRefreshHint, PlatformUpgradeAvailable } from '../shared/protocol.js';
import { AutoUpgradeController, checkCrashLoopOnStartup, scheduleUpgradeVerification } from './auto-upgrade.js';
import {
  defaultConfig,
  applyRuntimeBuildInfo,
  loadConfig,
  redactConfig,
  saveConfig,
  type ProviderNodeConfig,
  type ProviderOAuthConfig,
  type ProviderUpstreamMode,
} from './config.js';
import { ProviderBridge } from './bridge.js';
import { applyClaudeCodeMetadataToOAuth, importClaudeCodeOAuth } from './claude-code-auth.js';
import { defaultCodexAuthJsonPath, importCodexAuthJson, resolveCodexAuthJsonPath } from './codex-auth-json.js';
import { inferManualReauthorizationCredentialIdFromPlatformCredentials } from './credential-reauthorization.js';
import {
  CSRF_HEADER_NAME,
  hasJsonContentType,
  isAllowedConsoleOrigin,
  isMutatingMethod,
  verifyCsrfToken,
} from './console-security.js';
import { detectLocalCredentials } from './local-auth-detect.js';
import { providerOAuthConfigFromManualTokenBody, validateManualOAuthConfigForAuthorization } from './manual-oauth-token.js';
import {
  applyTokenToOAuthConfig,
  createAnthropicOAuthStart,
  createCodexOAuthStart,
  exchangeAnthropicCode,
  formatAnthropicAuthorizationCode,
  exchangeCodexCode,
  parseAnthropicAuthorizationCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
  verifyState,
  type CodexDeviceCode,
  type OAuthStart,
  type OAuthTokenResponse,
} from './oauth.js';

const CONFIG_PATH = getEnv('PROVIDER_CONFIG_PATH', './data/provider-node.json');
const CONSOLE_HOST = getEnv('PROVIDER_CONSOLE_HOST', '127.0.0.1');
const CONSOLE_PORT = getEnvNumber('PROVIDER_CONSOLE_PORT', 16888);
const CONSOLE_CSRF_TOKEN = randomBytes(32).toString('base64url');

// Anti-DNS-rebinding allowlist for the local console. A malicious page the provider
// opens in their browser can re-resolve its own domain to 127.0.0.1 and POST to the
// console (bind/config/unbind), but the browser still sends that domain in the Host
// header — it cannot forge `127.0.0.1`. So we accept only requests whose Host names a
// loopback alias (or the explicitly configured bind host / extra allowlist).
const CONSOLE_ALLOWED_HOSTS = buildConsoleAllowedHosts();
function buildConsoleAllowedHosts(): Set<string> {
  const hosts = new Set<string>(['127.0.0.1', 'localhost', '::1']);
  const configured = CONSOLE_HOST.trim().toLowerCase();
  if (configured && !['0.0.0.0', '::'].includes(configured)) hosts.add(configured);
  for (const extra of getEnv('PROVIDER_CONSOLE_ALLOWED_HOSTS', '').split(',')) {
    const host = extra.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}
function hostnameFromHostHeader(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(0, colon) : value;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Control-plane host allowlist. The Node must only ever be pointed at the real
// Wokey Platform (or a self-hoster's explicitly trusted domain). A phishing link to the
// local console carrying a crafted `platformBindUrl` passes the Host check (it really
// loads from 127.0.0.1), so without this gate it could repoint the Node's control plane
// at an attacker and turn the official-exit tunnel into an SSRF. Loopback stays allowed
// for local development; custom Platform domains go in PROVIDER_PLATFORM_HOST_ALLOWLIST.
const PLATFORM_HOST_LOOPBACK = new Set<string>(['127.0.0.1', 'localhost', '::1']);
const PLATFORM_TRUSTED_DOMAINS = ['wokey.ai'];
const PLATFORM_HOST_ALLOWLIST = new Set<string>(
  getEnv('PROVIDER_PLATFORM_HOST_ALLOWLIST', '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
function isLoopbackPlatformHost(hostname: string): boolean {
  return PLATFORM_HOST_LOOPBACK.has(hostname.trim().toLowerCase());
}
function isAllowedPlatformHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (isLoopbackPlatformHost(host)) return true;
  if (PLATFORM_TRUSTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  return PLATFORM_HOST_ALLOWLIST.has(host);
}
function assertAllowedPlatformUrl(rawUrl: string, allowedSchemes: string[], tlsSchemes: string[]): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('platform_url_invalid');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!allowedSchemes.includes(scheme)) throw new Error('platform_url_scheme_not_allowed');
  if (!isAllowedPlatformHost(url.hostname)) throw new Error('platform_url_host_not_allowed');
  if (!isLoopbackPlatformHost(url.hostname) && !tlsSchemes.includes(scheme)) {
    throw new Error('platform_url_tls_required');
  }
}

function uninstallCommand(purgeData: boolean): string {
  const purgeFlag = purgeData ? ' --purge' : '';
  if (process.platform === 'win32') {
    return 'powershell -NoProfile -ExecutionPolicy Bypass -Command "wokey-node uninstall-service"';
  }
  if (process.platform === 'linux') {
    return `wokey-node uninstall-service && sudo rm -rf /opt/wokey-provider-node /usr/local/bin/wokey-node${purgeData ? ' ~/.config/wokey-provider-node' : ''}`;
  }
  return `sudo /usr/local/bin/wokey-node uninstall${purgeFlag}`;
}

function writeMacUninstallCommand(purgeData: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-provider-node-uninstall-'));
  const scriptPath = join(dir, 'Uninstall Wokey Provider Node.command');
  const purgeArg = purgeData ? ' --purge' : '';
  const script = `#!/bin/sh
clear
echo "Wokey Provider Node uninstall"
echo
if [ ! -x /usr/local/bin/wokey-node ]; then
  echo "wokey-node was not found at /usr/local/bin/wokey-node."
  echo "It may already be removed."
  echo
  read -r -p "Press Return to close this window..."
  exit 0
fi
sudo /usr/local/bin/wokey-node uninstall${purgeArg}
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "Uninstall finished."
else
  echo "Uninstall failed with status $status."
fi
echo
read -r -p "Press Return to close this window..."
exit "$status"
`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}
const CODEX_AUTH_JSON_SYNC_EXPIRY_SKEW_MS = getEnvNumber('CODEX_AUTH_JSON_SYNC_EXPIRY_SKEW_MS', 10 * 60_000);
const CODEX_AUTH_JSON_SYNC_NEAR_INTERVAL_MS = getEnvNumber('CODEX_AUTH_JSON_SYNC_NEAR_INTERVAL_MS', 60_000);
const CODEX_AUTH_JSON_SYNC_HINT_WINDOW_MS = getEnvNumber('CODEX_AUTH_JSON_SYNC_HINT_WINDOW_MS', 10 * 60_000);
const CODEX_AUTH_JSON_SYNC_HINT_INTERVAL_MS = getEnvNumber('CODEX_AUTH_JSON_SYNC_HINT_INTERVAL_MS', 60_000);
const CODEX_AUTH_JSON_SYNC_BACKSTOP_MS = getEnvNumber('CODEX_AUTH_JSON_SYNC_BACKSTOP_MS', 6 * 60 * 60_000);
const MAX_PENDING_OAUTH_FLOWS = 5;
const baseConfig = defaultConfig();

let config: ProviderNodeConfig;
try {
  config = loadConfig(CONFIG_PATH);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `\nWokey Provider Node could not load its config at ${CONFIG_PATH}.\n` +
    `Reason: ${reason}\n\n` +
    'If you set PROVIDER_NODE_MASTER_KEY, make sure it matches the key that encrypted this config.\n' +
    'Otherwise the config file may be corrupt — remove it to start fresh (you will need to re-bind and re-authorize).\n\n',
  );
  process.exit(1);
}
const pendingCodexOAuth = new Map<string, OAuthStart>();
const pendingAnthropicOAuth = new Map<string, OAuthStart>();
const pendingCodexDeviceCodes = new Map<string, CodexDeviceCode>();
let codexBrowserAttempt: {
  flow: OAuthStart;
  port: number;
  server: HttpServer;
  status: 'pending' | 'succeeded' | 'failed';
  error?: string;
  startedAt: string;
} | null = null;
let codexAuthJsonSyncInFlight = false;
let codexAuthJsonSyncTimer: NodeJS.Timeout | undefined;
let codexAuthJsonHintUntil = 0;

type PlatformBindingServerStatus = 'bound' | 'unbound' | 'invalid' | 'unavailable';

interface PlatformBindingStatus {
  ok: true;
  local: {
    isBound: boolean;
    providerId: string;
    nodeId: string;
    platformBindUrl: string;
  };
  server: {
    status: PlatformBindingServerStatus;
    providerId?: string;
    nodeId?: string;
    nodeStatus?: string;
    nodeVersion?: string;
    versionStatus?: string;
    lastSeenAt?: string;
    error?: string;
  };
}

type CodexAuthJsonMirrorConfig = NonNullable<NonNullable<ProviderNodeConfig['localAuth']>['codexAuthJsonMirror']>;

const app = Fastify({
  // Match routes regardless of a trailing slash; internal rewrite, not a redirect.
  routerOptions: { ignoreTrailingSlash: true },
  logger: {
    level: getEnv('LOG_LEVEL', 'info'),
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

// Reject any request whose Host header is not a trusted loopback/bind name. Runs
// before routing so it covers every console endpoint (reads and writes alike),
// closing the DNS-rebinding path into bind/config and account-metadata reads.
app.addHook('onRequest', async (request, reply) => {
  const hostname = hostnameFromHostHeader(request.headers.host ?? '');
  if (!CONSOLE_ALLOWED_HOSTS.has(hostname)) {
    reply.code(403).send({ ok: false, error: 'forbidden_host' });
    return reply;
  }

  if (!request.url.startsWith('/api/') || !isMutatingMethod(request.method)) return;

  const origin = headerString(request.headers.origin);
  const referer = headerString(request.headers.referer);
  if (!isAllowedConsoleOrigin(origin, CONSOLE_ALLOWED_HOSTS) || (referer && !isAllowedConsoleOrigin(referer, CONSOLE_ALLOWED_HOSTS))) {
    reply.code(403).send({ ok: false, error: 'forbidden_origin' });
    return reply;
  }

  if (!hasJsonContentType(headerString(request.headers['content-type']))) {
    reply.code(415).send({ ok: false, error: 'json_content_type_required' });
    return reply;
  }

  if (!verifyCsrfToken(headerString(request.headers[CSRF_HEADER_NAME]), CONSOLE_CSRF_TOKEN)) {
    reply.code(403).send({ ok: false, error: 'csrf_token_required' });
    return reply;
  }
});

// Uniform error envelope. Handlers signal client errors by throwing a snake_case
// code (e.g. `throw new Error('code_required')`); those map to HTTP 400 with
// `{ ok: false, error }`. Anything else is an unexpected fault → 500 (and logged),
// so the same shape comes back regardless of which handler failed.
const CLIENT_ERROR_CODE = /^[a-z][a-z0-9_]*$/;
app.setErrorHandler((error: Error, request, reply) => {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    reply.code(statusCode).send({ ok: false, error: error.message || 'bad_request' });
    return;
  }
  if (error.message && CLIENT_ERROR_CODE.test(error.message)) {
    reply.code(400).send({ ok: false, error: error.message });
    return;
  }
  request.log.error({ err: error }, 'unhandled console error');
  reply.code(500).send({ ok: false, error: 'internal_error' });
});

const autoUpgrade = new AutoUpgradeController({
  configPath: CONFIG_PATH,
  getInFlight: () => bridge.state.inFlight,
  stopBridge: () => bridge.stop(),
  log: app.log,
});

const bridge = new ProviderBridge(
  () => config,
  {
    onPlatformReady: () => scheduleCodexAuthJsonMirrorCheck(1_000),
    onPlatformCredentialRefreshHint: handlePlatformCredentialRefreshHint,
    onPlatformUpgradeAvailable: (msg: PlatformUpgradeAvailable) => {
      if (config.autoUpdate === false) {
        app.log.info({}, 'auto-upgrade: disabled by config, ignoring upgrade_available');
        return;
      }
      void autoUpgrade.handleUpgradeAvailable(msg);
    },
  },
);

app.get('/', async (_request, reply) => {
  reply.type('text/html; charset=utf-8').send(page());
});

app.get('/bind', async (_request, reply) => {
  reply.type('text/html; charset=utf-8').send(page());
});

app.get('/api/status', async () => ({
  bridge: bridge.state,
  config: redactConfig(config),
  binding: {
    isBound: isNodeBound(config),
    platformBindUrl: platformHttpUrl(config.platformWsUrl, '/internal/provider/bind'),
    lastMessage: 'ok',
  },
  codex: {
    defaultAuthJsonPath: defaultCodexAuthJsonPath(),
    browserLogin: codexBrowserAttempt
      ? {
        status: codexBrowserAttempt.status,
        port: codexBrowserAttempt.port,
        error: codexBrowserAttempt.error,
        startedAt: codexBrowserAttempt.startedAt,
      }
      : undefined,
  },
}));

app.get('/api/csrf', async () => ({ ok: true, token: CONSOLE_CSRF_TOKEN }));

app.get('/api/config', async () => redactConfig(config));

app.post('/api/config', async (request, reply) => {
  const patch = request.body as Partial<ProviderNodeConfig>;
  // Only gate an actual repoint of the control plane, not a re-save of the existing
  // value, so config edits to unrelated settings never break an already-running node.
  const nextWsUrl = typeof patch.platformWsUrl === 'string' ? patch.platformWsUrl.trim() : undefined;
  if (nextWsUrl && nextWsUrl !== config.platformWsUrl) {
    try {
      assertAllowedPlatformUrl(nextWsUrl, ['ws', 'wss'], ['wss']);
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : 'platform_url_not_allowed' };
    }
  }
  config = mergeConfigPatch(config, patch);
  persistConfig(true);
  return { ok: true, config: redactConfig(config) };
});

app.post('/api/system/uninstall/start', async (request, reply) => {
  const body = request.body as { confirm?: string; purgeData?: boolean };
  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
  if (confirm !== 'UNINSTALL' && confirm !== '卸载') {
    reply.code(400);
    return { ok: false, error: 'uninstall_confirmation_required' };
  }

  const purgeData = Boolean(body.purgeData);
  const command = uninstallCommand(purgeData);
  if (process.platform !== 'darwin') {
    return { ok: true, started: false, command };
  }

  const scriptPath = writeMacUninstallCommand(purgeData);
  const child = spawn('/usr/bin/open', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, started: true };
});

app.post('/api/platform/bind', async (request, reply) => {
  const body = request.body as { bindingCode?: string; platformBindUrl?: string };
  if (!body.bindingCode?.trim()) {
    reply.code(400);
    return { ok: false, error: 'binding_code_required' };
  }

  const bindUrl = body.platformBindUrl?.trim() || platformHttpUrl(config.platformWsUrl, '/internal/provider/bind');
  try {
    assertAllowedPlatformUrl(bindUrl, ['http', 'https'], ['https']);
  } catch (error) {
    reply.code(400);
    return { ok: false, error: error instanceof Error ? error.message : 'platform_url_not_allowed' };
  }
  const response = await fetch(bindUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bindingCode: body.bindingCode.trim(),
      nodeId: config.nodeId,
      nodeVersion: config.nodeVersion,
    }),
  });
  const data = await parseJsonResponse<{
    providerId: string;
    nodeId?: string;
    providerNodeSecret: string;
    platformWsUrl: string;
  }>(response);
  try {
    assertAllowedPlatformUrl(data.platformWsUrl, ['ws', 'wss'], ['wss']);
  } catch (error) {
    reply.code(400);
    return { ok: false, error: error instanceof Error ? error.message : 'platform_url_not_allowed' };
  }

  config = {
    ...config,
    providerId: data.providerId,
    nodeId: data.nodeId || config.nodeId,
    providerNodeSecret: data.providerNodeSecret,
    platformWsUrl: data.platformWsUrl,
    runtimeMode: config.runtimeMode === 'development' ? 'official_exit' : config.runtimeMode,
    officialExit: {
      ...config.officialExit,
      enabled: true,
    },
  };
  persistConfig(true);
  return { ok: true, config: redactConfig(config) };
});

app.post('/api/platform/unbind', async () => {
  if (isNodeBound(config)) {
    const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/unbind'), {
      method: 'POST',
      headers: providerCredentialHeaders(),
    });
    await parseJsonResponse<unknown>(response);
  }

  config = {
    ...config,
    providerId: baseConfig.providerId,
    platformWsUrl: baseConfig.platformWsUrl,
    providerNodeSecret: baseConfig.providerNodeSecret,
    runtimeMode: 'development',
    officialExit: {
      ...config.officialExit,
      enabled: false,
    },
    localAuth: {
      ...config.localAuth,
      codexAuthJsonMirror: undefined,
    },
  };
  persistConfig(true);
  return { ok: true, config: redactConfig(config) };
});

app.get('/api/platform/credentials', async (_request, reply) => {
  if (!isNodeBound(config)) {
    reply.code(400);
    return { ok: false, error: 'node_not_bound', data: [] };
  }
  const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/credentials'), {
    headers: providerCredentialHeaders(),
  });
  const data = await parseJsonResponse<{ data?: unknown[] }>(response);
  return { ok: true, data: Array.isArray(data.data) ? data.data : [] };
});

app.get('/api/platform/binding-status', async (): Promise<PlatformBindingStatus> => {
  const binding = await platformBindingStatus();
  // A paused node now reports status 'bound' with nodeStatus 'paused' (so the console can
  // tell a deliberate pause apart from a rejected binding). Only auto-reconnect once the
  // node is actually active again — otherwise we'd hammer reconnects while still paused.
  if (
    binding.server.status === 'bound'
    && binding.server.nodeStatus !== 'paused'
    && bridge.state.reconnectSuppressedReason === 'node_paused'
    && !bridge.state.connected
  ) {
    bridge.reconnectNow();
  }
  return binding;
});

app.post('/api/platform/credentials', async (request, reply) => {
  if (!isNodeBound(config)) {
    reply.code(400);
    return { ok: false, error: 'node_not_bound' };
  }
  const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/credentials'), {
    method: 'POST',
    headers: {
      ...providerCredentialHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(currentOAuthCredentialBody(request.body as Record<string, unknown>)),
  });
  const data = await parseJsonResponse<unknown>(response);
  return { ok: true, ...asObject(data) };
});

app.post('/api/platform/credentials/authorize-local', async (request, reply) => {
  if (!isNodeBound(config)) {
    reply.code(400);
    return { ok: false, error: 'node_not_bound' };
  }
  await assertPlatformBindingIsUsable();
  const body = request.body as { source?: string; path?: string };
  let vendor: 'openai' | 'anthropic';
  let oauth: ProviderOAuthConfig;

  const isCodexAuthJsonSource = body.source === 'codex-auth-json';
  if (isCodexAuthJsonSource) {
    vendor = 'openai';
    oauth = importCodexAuthJson(body.path);
    oauth.accessTokenSource = 'codex_auth_json';
  } else if (body.source === 'claude-code') {
    vendor = 'anthropic';
    oauth = importClaudeCodeOAuth();
    oauth.accessTokenSource = 'claude_code_local';
  } else {
    throw new Error('local_auth_source_not_supported');
  }

  if (vendor === 'anthropic') enrichAnthropicOAuthFromClaudeMetadata(oauth);
  const authorization = await authorizeOAuthCredential(oauth, vendor, request.body as Record<string, unknown>);
  if (isCodexAuthJsonSource) {
    rememberCodexAuthJsonMirror(body.path, oauth, authorization);
  }
  return authorization;
});

app.post('/api/platform/credentials/authorize-token', async (request, reply) => {
  if (!isNodeBound(config)) {
    reply.code(400);
    return { ok: false, error: 'node_not_bound' };
  }
  await assertPlatformBindingIsUsable();
  const body = request.body as Record<string, unknown>;
  const vendor: 'openai' | 'anthropic' = body.vendor === 'anthropic' ? 'anthropic' : 'openai';
  const oauth = providerOAuthConfigFromManualTokenBody(body, vendor);
  oauth.accessTokenSource = 'manual_token';
  try {
    validateManualOAuthConfigForAuthorization(oauth, vendor);
  } catch (error) {
    reply.code(400);
    return { ok: false, error: error instanceof Error ? error.message : 'invalid_oauth_token' };
  }
  const authorization = await authorizeOAuthCredential(oauth, vendor, body);
  config.upstream = { ...config.upstream, mode: vendor === 'anthropic' ? 'anthropic-oauth' : 'codex-oauth', oauth };
  persistConfig();
  return authorization;
});

app.get('/api/oauth/local/detect', async () => ({
  ok: true,
  data: localCredentialDetections(),
}));

app.post('/api/oauth/direct', async (request) => {
  const body = request.body as {
    mode?: ProviderUpstreamMode;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    tokenType?: string;
    expiresAt?: number | string;
    scope?: string;
    organizationId?: string;
    accountEmail?: string;
  };
  const oauth: ProviderOAuthConfig = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    idToken: body.idToken,
    tokenType: body.tokenType || 'Bearer',
    expiresAt: parseExpiresAt(body.expiresAt),
    scope: body.scope,
    organizationId: body.organizationId,
    accountEmail: body.accountEmail,
  };
  config.upstream = { ...config.upstream, mode: normalizeOAuthMode(body.mode), oauth };
  persistConfig();
  return { ok: true, config: redactConfig(config) };
});

app.post('/api/oauth/codex/start', async (request) => {
  const body = request.body as { redirectUri?: string };
  const flow = createCodexOAuthStart(body.redirectUri);
  pendingCodexOAuth.set(flow.state, flow);
  return publicOAuthStart(flow);
});

app.post('/api/oauth/codex/exchange', async (request) => {
  const body = request.body as { code?: string; state?: string; redirectUri?: string };
  if (!body.code) throw new Error('code_required');
  const flow = body.state ? pendingCodexOAuth.get(body.state) : undefined;
  if (!flow) throw new Error('codex_oauth_start_required');
  if (body.state && flow && !verifyState(body.state, flow.state)) throw new Error('invalid_state');
  const token = await exchangeCodexCode({
    code: body.code,
    codeVerifier: flow.codeVerifier,
    redirectUri: body.redirectUri || flow?.redirectUri,
  });
  const receivedAt = new Date().toISOString();
  const oauth = setOAuthToken('codex-oauth', token, {
    accessTokenReceivedAt: receivedAt,
    accessTokenSource: 'codex_oauth_code',
    lastRefreshAt: receivedAt,
  });
  if (body.state) pendingCodexOAuth.delete(body.state);
  return authorizeOAuthCredential(oauth, 'openai', body);
});

app.post('/api/oauth/codex/browser/start', async () => {
  await startCodexBrowserAttempt();
  return {
    ok: true,
    status: codexBrowserAttempt?.status,
    port: codexBrowserAttempt?.port,
    authorizationUrl: codexBrowserAttempt?.flow.authorizationUrl,
    redirectUri: codexBrowserAttempt?.flow.redirectUri,
    startedAt: codexBrowserAttempt?.startedAt,
  };
});

app.get('/api/oauth/codex/browser/status', async () => ({
  ok: true,
  status: codexBrowserAttempt?.status ?? 'idle',
  port: codexBrowserAttempt?.port,
  error: codexBrowserAttempt?.error,
  startedAt: codexBrowserAttempt?.startedAt,
}));

app.post('/api/oauth/codex/auth-json/import', async (request) => {
  const body = request.body as { path?: string };
  const oauth = importCodexAuthJson(body.path);
  config.upstream = { ...config.upstream, mode: 'codex-oauth', oauth };
  persistConfig();
  return { ok: true, config: redactConfig(config) };
});

app.post('/api/oauth/codex/device/start', async () => {
  const deviceCode = await requestCodexDeviceCode();
  pendingCodexDeviceCodes.set(deviceCode.deviceAuthId, deviceCode);
  return { ok: true, ...deviceCode };
});

app.post('/api/oauth/codex/device/poll', async (request) => {
  const body = request.body as { deviceAuthId?: string };
  if (!body.deviceAuthId) throw new Error('device_auth_id_required');
  const deviceCode = pendingCodexDeviceCodes.get(body.deviceAuthId);
  if (!deviceCode) throw new Error('device_auth_not_found');
  if (Date.now() > deviceCode.expiresAt) {
    pendingCodexDeviceCodes.delete(body.deviceAuthId);
    return { ok: false, status: 'expired' };
  }
  const result = await pollCodexDeviceCode({
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
  });
  if (result.status === 'pending') return { ok: true, status: 'pending' };
  const receivedAt = new Date().toISOString();
  const oauth = setOAuthToken('codex-oauth', result.token, {
    accessTokenReceivedAt: receivedAt,
    accessTokenSource: 'codex_device_code',
    lastRefreshAt: receivedAt,
  });
  pendingCodexDeviceCodes.delete(body.deviceAuthId);
  const authorization = await authorizeOAuthCredential(oauth, 'openai', {});
  return { ok: true, status: 'succeeded', authorization };
});

app.post('/api/oauth/anthropic/start', async () => {
  const flow = createAnthropicOAuthStart();
  pendingAnthropicOAuth.set(flow.state, flow);
  trimPendingOAuthFlows(pendingAnthropicOAuth);
  return publicOAuthStart(flow);
});

app.post('/api/oauth/anthropic/exchange', async (request, reply) => {
  const body = request.body as { code?: string; state?: string; flowState?: string; setupToken?: boolean };
  if (!body.code) throw new Error('code_required');
  const parsedCode = parseAnthropicAuthorizationCode(body.code);
  if (!parsedCode.code) throw new Error('code_required');
  const candidateStates = Array.from(new Set([parsedCode.state, body.state, body.flowState].filter((value): value is string => Boolean(value))));
  let matchedState = candidateStates.find((state) => {
    const candidate = pendingAnthropicOAuth.get(state);
    return candidate ? verifyState(state, candidate.state) : false;
  });
  let flow = matchedState ? pendingAnthropicOAuth.get(matchedState) : undefined;
  let flowSource = matchedState ? 'state' : 'none';
  // Fall back to the sole outstanding flow ONLY when there is exactly one. This
  // keeps the paste UX working when a state is stripped/mangled, while PKCE binds
  // the code to that flow's verifier. With multiple pending flows we refuse rather
  // than guess, so a code carrying an unknown state cannot be matched to an
  // unrelated flow.
  if (!flow && pendingAnthropicOAuth.size === 1) {
    const sole = Array.from(pendingAnthropicOAuth.entries())[0];
    if (sole) {
      [matchedState, flow] = sole;
      flowSource = 'sole-pending';
    }
  }
  request.log.info({
    pendingFlows: pendingAnthropicOAuth.size,
    flowSource,
    parsedState: shortSecret(parsedCode.state),
    bodyState: shortSecret(body.state),
    flowState: shortSecret(body.flowState),
    matchedState: shortSecret(matchedState),
  }, 'Claude OAuth exchange flow selected');
  if (!flow) {
    reply.code(400);
    return {
      ok: false,
      error: 'anthropic_oauth_start_required',
      message: 'This Claude authorization flow has expired. Refresh this page, generate a new authorization link, then submit the new code.',
    };
  }
  let token: OAuthTokenResponse;
  try {
    const tokenState = parsedCode.state || matchedState;
    token = await exchangeAnthropicCode({
      code: formatAnthropicAuthorizationCode({ code: parsedCode.code, state: tokenState }),
      codeVerifier: flow.codeVerifier,
      setupToken: body.setupToken,
    });
  } catch (error) {
    const status = upstreamOAuthErrorStatus(error);
    if (!status) throw error;
    reply.code(status);
    return {
      ok: false,
      error: 'anthropic_oauth_exchange_failed',
      message: oauthExchangeFailureMessage(error),
    };
  }
  const receivedAt = new Date().toISOString();
  const oauth = setOAuthToken('anthropic-oauth', token, {
    accessTokenReceivedAt: receivedAt,
    accessTokenSource: 'anthropic_oauth_code',
    lastRefreshAt: receivedAt,
  });
  if (matchedState) pendingAnthropicOAuth.delete(matchedState);
  return authorizeOAuthCredential(oauth, 'anthropic', body);
});

let cachedConsoleHtml: string | undefined;

// The console is built into dist/console/index.html by scripts/build-console.mjs.
// Resolve it relative to this module so it works from the compiled dist tree and
// from src under tsx in development.
function consoleHtmlPath(): string {
  const candidates = [
    new URL('../console/index.html', import.meta.url),
    new URL('../../dist/console/index.html', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error('console_asset_missing: run `npm run build` to generate dist/console/index.html');
}

function page(): string {
  if (!cachedConsoleHtml) {
    const html = readFileSync(consoleHtmlPath(), 'utf8');
    cachedConsoleHtml = html.replace('__WOKEY_CSRF_JSON__', scriptJson(CONSOLE_CSRF_TOKEN));
  }
  return cachedConsoleHtml;
}

function persistConfig(reconnect = false): void {
  saveConfig(CONFIG_PATH, config);
  if (reconnect) bridge.reconnectNow();
}

function isNodeBound(value: ProviderNodeConfig): boolean {
  return Boolean(
    value.providerId
    && value.providerNodeSecret
    && (
      value.providerId !== baseConfig.providerId
      || value.providerNodeSecret !== baseConfig.providerNodeSecret
      || value.platformWsUrl !== baseConfig.platformWsUrl
    ),
  );
}

export function mergeConfigPatch(current: ProviderNodeConfig, patch: Partial<ProviderNodeConfig>): ProviderNodeConfig {
  const next: ProviderNodeConfig = {
    ...current,
    ...patch,
    providerNodeSecret: patch.providerNodeSecret === '***' ? current.providerNodeSecret : patch.providerNodeSecret ?? current.providerNodeSecret,
    upstream: {
      ...current.upstream,
      ...patch.upstream,
      apiKey: patch.upstream?.apiKey === '***' ? current.upstream.apiKey : patch.upstream?.apiKey ?? current.upstream.apiKey,
      oauth: patch.upstream?.oauth ? {
        ...current.upstream.oauth,
        ...patch.upstream.oauth,
        accessToken: patch.upstream.oauth.accessToken === '***' ? current.upstream.oauth?.accessToken : patch.upstream.oauth.accessToken ?? current.upstream.oauth?.accessToken,
        refreshToken: patch.upstream.oauth.refreshToken === '***' ? current.upstream.oauth?.refreshToken : patch.upstream.oauth.refreshToken ?? current.upstream.oauth?.refreshToken,
        idToken: patch.upstream.oauth.idToken === '***' ? current.upstream.oauth?.idToken : patch.upstream.oauth.idToken ?? current.upstream.oauth?.idToken,
      } : current.upstream.oauth,
    },
    officialExit: patch.officialExit ? {
      ...current.officialExit,
      enabled: patch.officialExit.enabled ?? current.officialExit?.enabled ?? false,
    } : current.officialExit,
    capability: patch.capability ? {
      ...current.capability,
      ...patch.capability,
    } : current.capability,
  };
  return applyRuntimeBuildInfo(next);
}

function normalizeOAuthMode(mode?: ProviderUpstreamMode): 'codex-oauth' | 'anthropic-oauth' {
  return mode === 'anthropic-oauth' ? 'anthropic-oauth' : 'codex-oauth';
}

function publicOAuthStart(flow: OAuthStart): Omit<OAuthStart, 'codeVerifier'> {
  return {
    authorizationUrl: flow.authorizationUrl,
    state: flow.state,
    redirectUri: flow.redirectUri,
  };
}

function trimPendingOAuthFlows(flows: Map<string, OAuthStart>): void {
  while (flows.size > MAX_PENDING_OAUTH_FLOWS) {
    const oldest = flows.keys().next().value;
    if (!oldest) break;
    flows.delete(oldest);
  }
}

function shortSecret(value?: string): string | undefined {
  if (!value) return undefined;
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function upstreamOAuthErrorStatus(error: unknown): number | undefined {
  const match = /^oauth_(\d{3}):/.exec(error instanceof Error ? error.message : String(error));
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 400 && status < 500 ? status : undefined;
}

function oauthExchangeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('invalid_grant')) {
    return 'Authorization code is invalid or has already been used. Generate a new Claude authorization link and submit the new code.';
  }
  if (message.includes('anthropic_browser_session_challenge')) {
    return 'Claude returned a browser security challenge for this authorization. Use Claude Code local authorization or generate a fresh Claude OAuth authorization link.';
  }
  if (message.includes('Request not allowed') || message.startsWith('oauth_403:')) {
    return 'Claude rejected this authorization code. Generate a new authorization link from this page, authorize again on Claude.ai, then submit the new code.';
  }
  return 'Claude authorization failed. Generate a new authorization link from this page and submit a fresh code.';
}

function parseExpiresAt(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function setOAuthToken(mode: 'codex-oauth' | 'anthropic-oauth', token: OAuthTokenResponse, extra?: Partial<ProviderOAuthConfig>): ProviderOAuthConfig {
  const previousOAuth = config.upstream.mode === mode ? config.upstream.oauth : undefined;
  const oauth = oauthConfigFromToken(token, { ...previousOAuth, ...extra });
  if (mode === 'anthropic-oauth') enrichAnthropicOAuthFromClaudeMetadata(oauth);
  else enrichOpenAIOAuthFromToken(oauth);
  config.upstream = { ...config.upstream, mode, oauth };
  persistConfig();
  return oauth;
}

function oauthConfigFromToken(token: OAuthTokenResponse, extra?: Partial<ProviderOAuthConfig>): ProviderOAuthConfig {
  const oauth: ProviderOAuthConfig = { ...extra };
  applyTokenToOAuthConfig(oauth, token);
  oauth.lastRefreshAt = new Date().toISOString();
  return oauth;
}

function enrichAnthropicOAuthFromClaudeMetadata(oauth: ProviderOAuthConfig): void {
  applyClaudeCodeMetadataToOAuth(oauth);
}

function enrichOpenAIOAuthFromToken(oauth: ProviderOAuthConfig): void {
  const derived = providerOAuthConfigFromManualTokenBody({
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    idToken: oauth.idToken,
    tokenType: oauth.tokenType,
    expiresAt: oauth.expiresAt,
    scope: oauth.scope,
  }, 'openai');
  oauth.organizationId = derived.organizationId || oauth.organizationId;
  oauth.accountEmail = derived.accountEmail || oauth.accountEmail;
  oauth.subscriptionType = derived.subscriptionType || oauth.subscriptionType;
  oauth.subscriptionDisplayName = derived.subscriptionDisplayName || oauth.subscriptionDisplayName;
}

function localCredentialDetections(): ReturnType<typeof detectLocalCredentials> {
  return detectLocalCredentials();
}

function currentOAuthCredentialBody(body: Record<string, unknown>): Record<string, unknown> {
  const oauth = config.upstream.oauth;
  if (!oauth?.accessToken) throw new Error('oauth_access_token_missing');
  const vendor = body.vendor === 'anthropic' || config.upstream.mode === 'anthropic-oauth' ? 'anthropic' : 'openai';
  if (vendor === 'anthropic') {
    const before = JSON.stringify({
      subscriptionType: oauth.subscriptionType,
      subscriptionDisplayName: oauth.subscriptionDisplayName,
      claudeCodeUserId: oauth.claudeCodeUserId,
      claudeCodeAccountUuid: oauth.claudeCodeAccountUuid,
    });
    enrichAnthropicOAuthFromClaudeMetadata(oauth);
    const after = JSON.stringify({
      subscriptionType: oauth.subscriptionType,
      subscriptionDisplayName: oauth.subscriptionDisplayName,
      claudeCodeUserId: oauth.claudeCodeUserId,
      claudeCodeAccountUuid: oauth.claudeCodeAccountUuid,
    });
    if (before !== after) persistConfig();
  }
  return oAuthCredentialBody(oauth, vendor, body);
}

function oAuthCredentialBody(
  oauth: ProviderOAuthConfig,
  vendor: 'openai' | 'anthropic',
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!oauth.accessToken) throw new Error('oauth_access_token_missing');
  const derived = providerOAuthConfigFromManualTokenBody({
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    idToken: oauth.idToken,
    tokenType: oauth.tokenType,
    expiresAt: oauth.expiresAt,
    scope: oauth.scope,
  }, vendor);
  return {
    vendor,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    tokenType: oauth.tokenType,
    scope: oauth.scope,
    organizationId: derived.organizationId || oauth.organizationId,
    accountEmail: derived.accountEmail || oauth.accountEmail,
    subscriptionType: derived.subscriptionType || oauth.subscriptionType,
    subscriptionDisplayName: derived.subscriptionDisplayName || oauth.subscriptionDisplayName,
    claudeCodeUserId: oauth.claudeCodeUserId || derived.claudeCodeUserId,
    claudeCodeAccountUuid: oauth.claudeCodeAccountUuid || derived.claudeCodeAccountUuid,
    accessTokenReceivedAt: oauth.accessTokenReceivedAt,
    accessTokenSource: oauth.accessTokenSource,
    lastRefreshAt: oauth.lastRefreshAt,
    modelAllowlist: Array.isArray(body.modelAllowlist) ? body.modelAllowlist : undefined,
    credentialBindingId: typeof body.credentialBindingId === 'string' ? body.credentialBindingId : undefined,
  };
}

async function authorizeOAuthCredential(
  oauth: ProviderOAuthConfig,
  vendor: 'openai' | 'anthropic',
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isNodeBound(config)) throw new Error('node_not_bound');
  oauth.accessTokenReceivedAt ||= new Date().toISOString();
  oauth.accessTokenSource ||= 'unknown';
  // 节点不再在授权时自刷:授权码/设备流的 token 刚签发必新鲜,codex auth.json 由本地 CLI 保鲜并经镜像同步给 relay。
  // 有效性 + 账号信息由 relay 写入期(verifyOAuthBundleForCredentialWrite)经渲染隧道校验;access token 若过期,
  // 由 relay 用 refresh_token 经隧道补刷(指纹一致)。节点自刷会以节点原生 JA3 命中授权端点,与该凭证渲染出口不一致。
  const credentialBody = oAuthCredentialBody(oauth, vendor, body);
  credentialBody.credentialBindingId ||= await inferManualReauthorizationCredentialId(credentialBody).catch(() => undefined);
  const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/credentials'), {
    method: 'POST',
    headers: {
      ...providerCredentialHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(credentialBody),
  });
  const data = await parseJsonResponse<unknown>(response);
  return { ok: true, ...asObject(data) };
}

async function inferManualReauthorizationCredentialId(credentialBody: Record<string, unknown>): Promise<string | undefined> {
  const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/credentials'), {
    headers: providerCredentialHeaders(),
  });
  const data = await parseJsonResponse<{ data?: unknown[] }>(response);
  return inferManualReauthorizationCredentialIdFromPlatformCredentials(
    credentialBody,
    Array.isArray(data.data) ? data.data : [],
    config.nodeId,
  );
}

function rememberCodexAuthJsonMirror(
  path: string | undefined,
  oauth: ProviderOAuthConfig,
  authorization: Record<string, unknown>,
): void {
  const credentialBindingId = credentialBindingIdFromAuthorization(authorization);
  if (!credentialBindingId) return;
  const now = new Date().toISOString();
  config.localAuth = {
    ...config.localAuth,
    codexAuthJsonMirror: {
      enabled: true,
      credentialBindingId,
      path: resolveCodexAuthJsonPath(path),
      tokenFingerprint: oauthTokenFingerprint(oauth),
      authIdentityFingerprint: oauthAuthIdentityFingerprint(oauth),
      organizationId: oauth.organizationId,
      accountEmail: oauth.accountEmail,
      lastCheckedAt: now,
      lastSyncedAt: now,
      lastError: undefined,
    },
  };
  persistConfig();
  scheduleCodexAuthJsonMirrorCheck(1_000);
}

function credentialBindingIdFromAuthorization(authorization: Record<string, unknown>): string | undefined {
  const credential = asObject(authorization.credential);
  const credentialBindingId = credential.credentialBindingId;
  return typeof credentialBindingId === 'string' && credentialBindingId ? credentialBindingId : undefined;
}

function handlePlatformCredentialRefreshHint(message: PlatformCredentialRefreshHint): void {
  const mirror = config.localAuth?.codexAuthJsonMirror;
  if (!mirror?.enabled || mirror.credentialBindingId !== message.credentialBindingId || message.vendor !== 'openai') return;
  codexAuthJsonHintUntil = Date.now() + CODEX_AUTH_JSON_SYNC_HINT_WINDOW_MS;
  scheduleCodexAuthJsonMirrorCheck(0);
}

function scheduleCodexAuthJsonMirrorCheck(delayMs?: number): void {
  if (codexAuthJsonSyncTimer) clearTimeout(codexAuthJsonSyncTimer);
  codexAuthJsonSyncTimer = undefined;
  const mirror = config.localAuth?.codexAuthJsonMirror;
  if (!mirror?.enabled || !mirror.credentialBindingId || !isNodeBound(config)) return;
  const delay = Math.max(0, delayMs ?? nextCodexAuthJsonMirrorDelayMs());
  codexAuthJsonSyncTimer = setTimeout(() => {
    codexAuthJsonSyncTimer = undefined;
    syncCodexAuthJsonMirror().catch((error) => app.log.warn(error));
  }, delay);
  codexAuthJsonSyncTimer.unref?.();
}

function nextCodexAuthJsonMirrorDelayMs(expiresAt?: number): number {
  const now = Date.now();
  if (codexAuthJsonHintUntil > now) return CODEX_AUTH_JSON_SYNC_HINT_INTERVAL_MS;
  if (expiresAt) {
    const untilNearExpiry = expiresAt - now - CODEX_AUTH_JSON_SYNC_EXPIRY_SKEW_MS;
    if (untilNearExpiry <= 0) return CODEX_AUTH_JSON_SYNC_NEAR_INTERVAL_MS;
    return CODEX_AUTH_JSON_SYNC_BACKSTOP_MS > 0
      ? Math.min(untilNearExpiry, CODEX_AUTH_JSON_SYNC_BACKSTOP_MS)
      : untilNearExpiry;
  }
  return CODEX_AUTH_JSON_SYNC_BACKSTOP_MS > 0 ? CODEX_AUTH_JSON_SYNC_BACKSTOP_MS : 24 * 60 * 60_000;
}

async function syncCodexAuthJsonMirror(): Promise<void> {
  if (codexAuthJsonSyncInFlight) return;
  const configuredMirror = config.localAuth?.codexAuthJsonMirror;
  if (!configuredMirror?.enabled || !configuredMirror.credentialBindingId || !isNodeBound(config)) return;
  const mirror: CodexAuthJsonMirrorConfig = configuredMirror;
  // Captured here where the guard above has narrowed it to a string, so later
  // async code needn't re-assert it.
  const credentialBindingId = configuredMirror.credentialBindingId;
  codexAuthJsonSyncInFlight = true;
  const checkedAt = new Date().toISOString();
  let nextExpiresAt: number | undefined;
  try {
    const oauth = importCodexAuthJson(mirror.path);
    nextExpiresAt = oauth.expiresAt;
    const expectedIdentityFingerprint = mirror.authIdentityFingerprint;
    const currentIdentityFingerprint = oauthAuthIdentityFingerprint(oauth);
    if (!expectedIdentityFingerprint || !currentIdentityFingerprint) {
      disableCodexAuthJsonMirror(mirror, checkedAt, 'codex_auth_json_identity_missing');
      return;
    }
    if (expectedIdentityFingerprint !== currentIdentityFingerprint) {
      disableCodexAuthJsonMirror(mirror, checkedAt, 'codex_auth_json_account_mismatch');
      return;
    }
    const tokenFingerprint = oauthTokenFingerprint(oauth);
    if (tokenFingerprint === mirror.tokenFingerprint) {
      const hadError = Boolean(mirror.lastError);
      config.localAuth = {
        ...config.localAuth,
        codexAuthJsonMirror: {
          ...mirror,
          lastCheckedAt: checkedAt,
          lastError: undefined,
        },
      };
      if (hadError) persistConfig();
      return;
    }
    await bridge.sendCredentialMirrorUpdate(oauthCredentialMirrorUpdateBody(credentialBindingId, oauth));
    codexAuthJsonHintUntil = 0;
    config.localAuth = {
      ...config.localAuth,
      codexAuthJsonMirror: {
        ...mirror,
        tokenFingerprint,
        authIdentityFingerprint: currentIdentityFingerprint || mirror.authIdentityFingerprint,
        organizationId: oauth.organizationId,
        accountEmail: oauth.accountEmail,
        lastCheckedAt: checkedAt,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      },
    };
    persistConfig();
    app.log.info({ credentialBindingId: mirror.credentialBindingId }, 'codex_auth_json_mirror_synced');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    config.localAuth = {
      ...config.localAuth,
      codexAuthJsonMirror: {
        ...mirror,
        lastCheckedAt: checkedAt,
        lastError: message,
      },
    };
    persistConfig();
    app.log.warn({ error: message }, 'codex_auth_json_mirror_sync_failed');
  } finally {
    codexAuthJsonSyncInFlight = false;
    scheduleCodexAuthJsonMirrorCheck(nextCodexAuthJsonMirrorDelayMs(nextExpiresAt));
  }
}

function disableCodexAuthJsonMirror(
  mirror: CodexAuthJsonMirrorConfig,
  checkedAt: string,
  reason: string,
): void {
  config.localAuth = {
    ...config.localAuth,
    codexAuthJsonMirror: {
      ...mirror,
      enabled: false,
      lastCheckedAt: checkedAt,
      lastError: reason,
    },
  };
  persistConfig();
  if (codexAuthJsonSyncTimer) clearTimeout(codexAuthJsonSyncTimer);
  codexAuthJsonSyncTimer = undefined;
  app.log.warn({ reason }, 'codex_auth_json_mirror_disabled');
}

function oauthCredentialMirrorUpdateBody(
  credentialBindingId: string,
  oauth: ProviderOAuthConfig,
): Parameters<ProviderBridge['sendCredentialMirrorUpdate']>[0] {
  if (!oauth.accessToken) throw new Error('oauth_access_token_missing');
  return {
    credentialBindingId,
    vendor: 'openai',
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    tokenType: oauth.tokenType,
    scope: oauth.scope,
    organizationId: oauth.organizationId,
    accountEmail: oauth.accountEmail,
    subscriptionType: oauth.subscriptionType,
    subscriptionDisplayName: oauth.subscriptionDisplayName,
    accessTokenReceivedAt: oauth.accessTokenReceivedAt,
    accessTokenSource: 'mirror',
    lastRefreshAt: oauth.lastRefreshAt,
  };
}

function oauthTokenFingerprint(oauth: ProviderOAuthConfig): string {
  return createHash('sha256')
    .update(JSON.stringify({
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      idToken: oauth.idToken,
      expiresAt: oauth.expiresAt,
    }))
    .digest('base64url');
}

function oauthAuthIdentityFingerprint(oauth: ProviderOAuthConfig): string | undefined {
  if (!oauth.organizationId && !oauth.accountEmail) return undefined;
  return createHash('sha256')
    .update(JSON.stringify({
      organizationId: oauth.organizationId || null,
      accountEmail: oauth.accountEmail || null,
    }))
    .digest('base64url');
}


async function platformBindingStatus(): Promise<PlatformBindingStatus> {
  const local = {
    isBound: isNodeBound(config),
    providerId: config.providerId,
    nodeId: config.nodeId,
    platformBindUrl: platformHttpUrl(config.platformWsUrl, '/internal/provider/bind'),
  };
  if (!local.isBound) {
    return {
      ok: true,
      local,
      server: {
        status: 'unbound',
      },
    };
  }

  try {
    const response = await fetch(platformHttpUrl(config.platformWsUrl, '/internal/provider/status'), {
      headers: providerCredentialHeaders(),
    });
    const data = await parseJsonResponse<{
      binding?: {
        status?: string;
        providerId?: string;
        nodeId?: string;
        nodeStatus?: string;
        nodeVersion?: string;
        versionStatus?: string;
        lastSeenAt?: string;
      };
    }>(response);
    return {
      ok: true,
      local,
      server: {
        status: data.binding?.status === 'bound' ? 'bound' : 'invalid',
        providerId: data.binding?.providerId,
        nodeId: data.binding?.nodeId,
        nodeStatus: data.binding?.nodeStatus,
        nodeVersion: data.binding?.nodeVersion,
        versionStatus: data.binding?.versionStatus,
        lastSeenAt: data.binding?.lastSeenAt,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Invalid provider node credentials' || message === 'Provider node is no longer active') {
      return {
        ok: true,
        local,
        server: {
          status: 'invalid',
          error: message,
        },
      };
    }
    return {
      ok: true,
      local,
      server: {
        status: 'unavailable',
        error: message,
      },
    };
  }
}

async function assertPlatformBindingIsUsable(): Promise<void> {
  const binding = await platformBindingStatus();
  if (binding.server.status === 'invalid' || binding.server.status === 'unbound') {
    throw new Error('Invalid provider node credentials');
  }
}

function providerCredentialHeaders(): Record<string, string> {
  return {
    'x-provider-node-id': config.nodeId,
    'x-provider-node-secret': config.providerNodeSecret,
  };
}

// Derive a Platform HTTP(S) endpoint from the bridge ws(s) URL, at the given path.
function platformHttpUrl(wsUrl: string, path: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  url.search = '';
  return url.toString();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) {
    const error = asObject(data).error;
    const message = typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message)
      : typeof error === 'string'
        ? error
        : `request_failed:${response.status}`;
    throw new Error(message);
  }
  return data;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function startCodexBrowserAttempt(): Promise<void> {
  await closeCodexBrowserAttempt();
  let lastError: unknown;
  for (const port of [1455, 1457]) {
    try {
      codexBrowserAttempt = await createCodexBrowserAttempt(port);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('codex_browser_start_failed');
}

async function createCodexBrowserAttempt(port: number): Promise<NonNullable<typeof codexBrowserAttempt>> {
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const flow = createCodexOAuthStart(redirectUri);
  const attempt: NonNullable<typeof codexBrowserAttempt> = {
    flow,
    port,
    server: createServer(),
    status: 'pending',
    startedAt: new Date().toISOString(),
  };

  attempt.server.on('request', (request, response) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url || '/', redirectUri);
        if (requestUrl.pathname !== '/auth/callback') {
          response.writeHead(404).end('Not found');
          return;
        }
        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');
        if (!code || !state || !verifyState(state, flow.state)) throw new Error('invalid_oauth_callback');
        const token = await exchangeCodexCode({ code, codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri });
        setOAuthToken('codex-oauth', token);
        attempt.status = 'succeeded';
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(htmlMessage('Codex connected', 'You can close this window and return to Wokey Node Management.'));
      } catch (error) {
        attempt.status = 'failed';
        attempt.error = error instanceof Error ? error.message : 'codex_browser_oauth_failed';
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(htmlMessage('Codex connection failed', attempt.error));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      attempt.server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      attempt.server.off('error', onError);
      resolve();
    };
    attempt.server.once('error', onError);
    attempt.server.once('listening', onListening);
    attempt.server.listen(port, '127.0.0.1');
  });
  return attempt;
}

async function closeCodexBrowserAttempt(): Promise<void> {
  if (!codexBrowserAttempt) return;
  const server = codexBrowserAttempt.server;
  codexBrowserAttempt = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function htmlMessage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family: system-ui; padding: 48px;"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}

async function shutdown(): Promise<void> {
  if (codexAuthJsonSyncTimer) clearTimeout(codexAuthJsonSyncTimer);
  bridge.stop();
  await closeCodexBrowserAttempt();
  await app.close();
}

// Imperative startup: open the outbound bridge, schedule local credential sync,
// bind the console, and install signal handlers. Kept out of module load so the
// app can be imported (e.g. by tests using `app.inject`) without binding a port
// or starting the bridge. Set PROVIDER_NODE_NO_AUTOSTART=1 to import-without-start.
function start(): void {
  checkCrashLoopOnStartup(CONFIG_PATH, app.log);
  bridge.start();
  scheduleCodexAuthJsonMirrorCheck(1_000);
  app.listen({ host: CONSOLE_HOST, port: CONSOLE_PORT }).then(() => {
    scheduleUpgradeVerification(CONFIG_PATH, app.log);
  }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  process.once('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
}

if (process.env.PROVIDER_NODE_NO_AUTOSTART !== '1') {
  start();
}

export { app, start, shutdown };
