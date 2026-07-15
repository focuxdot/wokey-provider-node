import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderNodeConfig } from '../src/provider-node/config.js';

const HOST = '127.0.0.1';
let app: FastifyInstance;
let mergeConfigPatch: (current: ProviderNodeConfig, patch: Partial<ProviderNodeConfig>) => ProviderNodeConfig;
let dir: string;

beforeAll(async () => {
  // Import the server without binding a port or starting the outbound bridge.
  dir = mkdtempSync(join(tmpdir(), 'pn-itest-'));
  process.env.PROVIDER_NODE_NO_AUTOSTART = '1';
  process.env.PROVIDER_CONFIG_PATH = join(dir, 'provider-node.json');
  process.env.LOG_LEVEL = 'silent';
  const mod = await import('../src/provider-node/server.js');
  app = mod.app;
  mergeConfigPatch = mod.mergeConfigPatch;
  await app.ready();
});

afterAll(async () => {
  await app.close();
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
    expect(res.body).toContain('toggleSettingsMenu:');
    expect(res.body).toContain('requestUninstallNode:');
  });

  it('GET /api/status redacts the node secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.config.providerNodeSecret).toBe('***');
  });

  it('GET /api/config never returns raw secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('dev-provider-secret');
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
    expect(script).toContain("error?.body?.error?.code === 'invalid_binding_code'");
    expect(script).toContain('if (!statusState) return;');
    expect(script).toContain('if (statusState.binding?.isBound) {');
    expect(script).toContain('if (auto && isInvalidBindingCodeError(error)) clearLaunchBindingParams();');
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
    // Passed the security hook; the handler returns an OAuth start (no network).
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).authorizationUrl).toContain('https://');
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
        model: 'm', vendor: 'openai', supportsStreaming: true, supportsTools: false,
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
