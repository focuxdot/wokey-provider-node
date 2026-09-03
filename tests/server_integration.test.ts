import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderNodeConfig } from '../src/provider-node/config.js';

const HOST = '127.0.0.1';
let app: FastifyInstance;
let mergeConfigPatch: (current: ProviderNodeConfig, patch: Partial<ProviderNodeConfig>) => ProviderNodeConfig;
let parseJsonResponse: <T>(response: Response) => Promise<T>;
let dir: string;
const originalHome = process.env.HOME;
const originalDreaminaCliPath = process.env.DREAMINA_CLI_PATH;

beforeAll(async () => {
  // Import the server without binding a port or starting the outbound bridge.
  dir = mkdtempSync(join(tmpdir(), 'pn-itest-'));
  process.env.PROVIDER_NODE_NO_AUTOSTART = '1';
  process.env.PROVIDER_CONFIG_PATH = join(dir, 'provider-node.json');
  process.env.LOG_LEVEL = 'silent';
  // Keep CLI discovery hermetic even when the developer machine has the
  // official Dreamina CLI installed in its default path.
  process.env.HOME = dir;
  delete process.env.DREAMINA_CLI_PATH;
  const mod = await import('../src/provider-node/server.js');
  app = mod.app;
  mergeConfigPatch = mod.mergeConfigPatch;
  parseJsonResponse = mod.parseJsonResponse;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDreaminaCliPath === undefined) delete process.env.DREAMINA_CLI_PATH;
  else process.env.DREAMINA_CLI_PATH = originalDreaminaCliPath;
  rmSync(dir, { recursive: true, force: true });
});

async function csrfToken(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/csrf', headers: { host: HOST } });
  return JSON.parse(res.body).token as string;
}

describe('console routes', () => {
  it('serves the console HTML at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('Object.assign(window');
    expect(res.body).toContain('selectProvider:');
    expect(res.body).toContain('startCodexDevice:');
    expect(res.body).toContain('startJimengAuthorization:');
    expect(res.body).toContain('installJimengCli:');
    expect(res.body).toContain('cancelJimengAuthorization:');
    expect(res.body).toContain('id="jimengInstallButton"');
    expect(res.body).toContain('id="jimengAuthorizationLink"');
    expect(res.body).toContain('toggleSettingsMenu:');
    expect(res.body).toContain('requestUninstallNode:');
  });

  it('GET /api/status redacts the node secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.config.providerNodeSecret).toBe('***');
    expect(body.xai).toEqual({});
    expect(body.jimeng).toMatchObject({
      available: false,
      configured: false,
      install: {
        supported: true,
        status: 'idle',
      },
    });
  });

  it('GET /api/config never returns raw secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('dev-provider-secret');
  });

  it('exposes Jimeng flow routes but requires a bound node', async () => {
    const token = await csrfToken();
    const start = await app.inject({
      method: 'POST',
      url: '/api/oauth/jimeng/start',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {},
    });
    const status = await app.inject({
      method: 'GET',
      url: '/api/oauth/jimeng/flow-1/status',
      headers: { host: HOST },
    });
    const cancel = await app.inject({
      method: 'POST',
      url: '/api/oauth/jimeng/flow-1/cancel',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {},
    });
    expect([start, status, cancel].map((response) => response.statusCode)).toEqual([400, 400, 400]);
    expect([start, status, cancel].map((response) => JSON.parse(response.body).error)).toEqual([
      'node_not_bound',
      'node_not_bound',
      'node_not_bound',
    ]);
  });

  it('guards Codex device polling against stale overlapping results', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');

    expect(script).toContain('let devicePollRunId = 0;');
    expect(script).toContain('function stopDevicePolling()');
    expect(script).toContain('function isDeviceAuthNotFound(error)');
    expect(script).toContain('function isTransientDevicePollError(error)');
    expect(script).toContain('async function copyTextToClipboard(text)');
    expect(script).toContain('function copyTextWithSelection(text)');
    expect(script).toContain('function selectCodexDeviceCode()');
    expect(script).toContain('function openCodexDeviceAuthPlaceholder()');
    expect(script).toContain("t('deviceCodeCopyBlocked')");
    expect(script).toContain("setToast('oauthResult', t('deviceCodeOpened'))");
    expect(script).toContain('startDevicePolling(data.interval || 5, { keepCurrentToast: true })');
    expect(script).toContain('let transientPollErrors = 0;');
    expect(script).toContain('const scheduleNextPoll = () =>');
    expect(script).toContain("setToast('oauthResult', t('deviceAuthorizationExpired'), 'error')");
  });

  it('delegates Grok polling to the versioned Platform persona flow', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/provider-node/server.ts', import.meta.url), 'utf8');

    expect(server).toContain("startPlatformOAuth<PlatformOAuthDeviceStart>('xai', { flow: 'device_code' })");
    expect(server).toContain("pollPlatformOAuth<PlatformOAuthPollResult>('xai', body.deviceCode)");
    expect(server).toContain('PROVIDER_OAUTH_EGRESS_CONTROL_PROTOCOL_VERSION');
    expect(server).not.toContain('new BoundedDevicePoller');
    expect(server).not.toContain('requestXaiDeviceCode');
    expect(script).toContain('schedule(data.nextPollAt)');
    expect(script).toContain("if (data.status === 'failed')");
    expect(script).toContain('statusState.xai?.deviceAuthorization');
    expect(script).toContain('scheduleXaiStatusWatch(xaiAuthorization)');
    expect(script).toContain("const latest = await api('/api/status')");
    expect(script).toContain("previousAuthorization?.status === 'pending'");
    expect(script).toContain('await loadCredentials(true)');
    expect(script).toContain('if (document.hidden)');
  });

  it('keeps Jimeng authorization local-console state isolated and cancellable', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');

    expect(script).toContain('let activeJimengFlow = null;');
    expect(script).toContain('let jimengPollRunId = 0;');
    expect(script).toContain('function startJimengPolling()');
    expect(script).toContain('async function cancelJimengAuthorization()');
    expect(script).toContain('target.opener = null');
    expect(script).toContain("authorizationLink.classList.remove('hidden')");
    expect(script).toContain("status.classList.toggle('warning', !available)");
    expect(script).toContain("t('jimengAuthorizationSucceeded')");
  });

  it('refreshes the console CSRF token once after a stale-token response', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');

    expect(script).toContain('let csrfToken = window.__WOKEY_CSRF__;');
    expect(script).toContain('let csrfTokenRefresh = null;');
    expect(script).toContain('function isCsrfTokenError(response, data)');
    expect(script).toContain("data?.error === 'csrf_token_required'");
    expect(script).toContain("csrfTokenRefresh = fetch('/api/csrf')");
    expect(script).toContain('return api(path, options, false);');
  });

  it('does not repeatedly redeem stale one-click binding URLs', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');

    expect(script).toContain('function clearLaunchBindingParams()');
    expect(script).toContain("apiErrorCode(error) === 'invalid_binding_code'");
    expect(script).toContain('if (!statusState) return;');
    expect(script).toContain('if (statusState.binding?.isBound) {');
    expect(script).toContain('if (auto && isInvalidBindingCodeError(error)) clearLaunchBindingParams();');
  });

  it('uploads only generic runtime identity as part of the binding request', () => {
    const server = readFileSync(new URL('../src/provider-node/server.ts', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../src/provider-node/bridge.ts', import.meta.url), 'utf8');
    const protocol = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
    const hello = protocol.slice(
      protocol.indexOf('export interface ProviderHello'),
      protocol.indexOf('export interface ProviderNodeRuntimeIdentity'),
    );

    expect(server).toContain('runtimeIdentity: currentProviderNodeRuntimeIdentity()');
    expect(bridge).not.toContain('runtimeIdentity');
    expect(hello).not.toContain('runtimeIdentity');
  });

  it('maps structured error codes to actionable bilingual console messages', () => {
    const script = readFileSync(new URL('../web/console/app.js', import.meta.url), 'utf8');

    expect(script).toContain("unsupported_country_region_territory: 'oauthUnsupportedRegion'");
    expect(script).toContain("oauth_connect_timeout: 'oauthConnectTimeout'");
    expect(script).toContain("platform_network_error: 'platformNetworkError'");
    expect(script).toContain("provider_node_internal_error: 'providerNodeUnexpectedError'");
    expect(script).toContain("t('errorIdLabel')");
    expect(script).toContain('requestId');
  });
});

describe('console security hook', () => {
  it('rejects a non-loopback Host (DNS-rebinding guard)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_host');
  });

  it('rejects a mutating /api request without a CSRF token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/unbind',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('csrf_token_required');
  });

  it('rejects a mutating /api request without a JSON content-type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/unbind',
      headers: { host: HOST, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).error).toBe('json_content_type_required');
  });

  it('rejects a cross-origin mutating request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/unbind',
      headers: { host: HOST, 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_origin');
  });

  it('allows a mutating request with a valid CSRF token', async () => {
    const token = await csrfToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth/codex/start',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {},
    });
    // Passed the security hook; the Platform-owned flow then rejects this unbound test node.
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('node_binding_invalid');
  });

  it('rejects plaintext Platform bind URLs for non-loopback hosts', async () => {
    const token = await csrfToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/bind',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {
        bindingCode: 'bind_test',
        platformBindUrl: 'http://node.wokey.ai/internal/provider/bind',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('platform_url_tls_required');
  });

  it('rejects plaintext Platform WebSocket URLs for non-loopback hosts', async () => {
    const token = await csrfToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/config',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {
        platformWsUrl: 'ws://node.wokey.ai:8443/internal/provider/connect',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('platform_url_tls_required');
  });

  it('requires explicit uninstall confirmation', async () => {
    const token = await csrfToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/uninstall/start',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: { confirm: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('uninstall_confirmation_required');
  });
});

describe('error envelope', () => {
  it('returns 404 as JSON, not an HTML error page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist', headers: { host: HOST } });
    expect(res.statusCode).toBe(404);
  });

  it('preserves a structured Platform error instead of collapsing it to internal_error', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: 'official_exit_node_offline',
          message: 'Provider node is not online',
          type: 'invalid_request_error',
        },
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );

    await expect(parseJsonResponse(response)).rejects.toMatchObject({
      name: 'PlatformHttpError',
      statusCode: 503,
      errorCode: 'official_exit_node_offline',
      message: 'Provider node is not online',
    });
  });

  it('classifies a malformed Platform response instead of collapsing it to internal_error', async () => {
    const response = new Response('<html>bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });

    await expect(parseJsonResponse(response)).rejects.toMatchObject({
      name: 'ProviderNodeError',
      errorCode: 'platform_invalid_response',
      statusCode: 502,
      upstreamStatus: 502,
      retryable: true,
    });
  });
});

describe('mergeConfigPatch secret-sentinel', () => {
  function base(): ProviderNodeConfig {
    return {
      nodeId: 'n',
      providerId: 'p',
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      providerNodeSecret: 'real-secret',
      nodeVersion: '0.0.0',
      upstream: { mode: 'openai-compatible', apiKey: 'real-key', oauth: { accessToken: 'real-access' } },
      capability: {
        model: 'm',
        vendor: 'openai',
        supportsStreaming: true,
        supportsTools: false,
      },
    } as ProviderNodeConfig;
  }

  it('keeps existing secrets when the patch sends the "***" sentinel', () => {
    const merged = mergeConfigPatch(base(), {
      providerNodeSecret: '***',
      upstream: { mode: 'openai-compatible', apiKey: '***', oauth: { accessToken: '***' } },
    });
    expect(merged.providerNodeSecret).toBe('real-secret');
    expect(merged.upstream.apiKey).toBe('real-key');
    expect(merged.upstream.oauth?.accessToken).toBe('real-access');
  });

  it('replaces secrets when the patch sends a real value', () => {
    const merged = mergeConfigPatch(base(), {
      providerNodeSecret: 'new-secret',
      upstream: { mode: 'openai-compatible', apiKey: 'new-key' },
    });
    expect(merged.providerNodeSecret).toBe('new-secret');
    expect(merged.upstream.apiKey).toBe('new-key');
  });
});
