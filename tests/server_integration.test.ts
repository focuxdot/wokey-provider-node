import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
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
    expect(res.body).toContain('startAntigravityOAuth:');
    expect(res.body).toContain('copyAntigravityAuthorizationLink:');
    expect(res.body).toContain('searchParams.get("code")');
    expect(res.body).toContain('antigravityOAuthTitle');
    expect(res.body).toContain('antigravityBrowserOpened');
    expect(res.body).toContain('startWorkBuddyOAuth');
    expect(res.body).toContain('workbuddyOAuthTitle');
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

    expect(script).toContain("unsupported_country_region_territory: 'vendorRegionUnsupported'");
    expect(script).toContain("official_exit_tls_non_tls_response: 'nodeNetworkIntercepted'");
    expect(script).toContain("official_exit_tls_certificate_verify_failed: 'nodeNetworkIntercepted'");
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

    const antigravity = await app.inject({
      method: 'POST',
      url: '/api/oauth/antigravity/start',
      headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': token },
      payload: {},
    });
    expect(antigravity.statusCode).toBe(401);
    expect(JSON.parse(antigravity.body).error).toBe('node_binding_invalid');
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

  it('carries only the whitelisted vendor error Platform forwards for a failed authorization', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: 'unsupported_country_region_territory',
          message: 'Vendor rejected this region. Vendor response: HTTP 403 · unsupported_country_region_territory',
          type: 'invalid_request_error',
          details: {
            upstream: {
              status: 403,
              code: 'unsupported_country_region_territory',
              message: 'Country, region, or territory not supported',
              extra: 'dropped',
            },
          },
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );

    const error = await parseJsonResponse(response).catch((err: unknown) => err);
    expect(error).toMatchObject({
      name: 'PlatformHttpError',
      statusCode: 403,
      errorCode: 'unsupported_country_region_territory',
    });
    expect((error as { details?: unknown }).details).toEqual({
      upstream: {
        status: 403,
        code: 'unsupported_country_region_territory',
        message: 'Country, region, or territory not supported',
      },
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

describe('local Platform + OAuth stub Antigravity flow', () => {
  it('runs risk gate, PKCE callback, token exchange, and credential bind without production services', async () => {
    const platform = Fastify({ logger: false });
    platform.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));

    const oauth = {
      riskAccepted: false,
      flow: undefined as undefined | { flowId: string; state: string; codeVerifier: string; redirectUri: string; authorizationUrl: string },
      code: undefined as undefined | { value: string; state: string; redirectUri: string; codeChallenge: string },
      tokenRequests: 0,
      boundCredential: undefined as undefined | Record<string, unknown>,
    };
    const nodeId = 'e2e-antigravity-node';
    const providerId = 'e2e-antigravity-provider';
    const providerSecret = 'e2e-antigravity-secret';

    let platformPort = 0;
    let oauthBaseUrl = '';

    platform.get('/internal/provider/status', async (request, reply) => {
      if (request.headers['x-provider-node-id'] !== nodeId || request.headers['x-provider-node-secret'] !== providerSecret) {
        reply.code(401);
        return { error: { code: 'invalid_provider_secret', message: 'Invalid provider node credentials' } };
      }
      return { binding: { status: 'bound', providerId, nodeId, nodeStatus: 'active', nodeVersion: '0.1.104', versionStatus: 'verified' } };
    });

    platform.get('/authorize', async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const redirectUri = query.redirect_uri ?? '';
      const state = query.state ?? '';
      const codeChallenge = query.code_challenge ?? '';
      if (!redirectUri || !state || !codeChallenge) {
        reply.code(400);
        return { error: 'invalid_authorization_request' };
      }
      const value = `stub-code-${randomBytes(8).toString('hex')}`;
      oauth.code = { value, state, redirectUri, codeChallenge };
      reply.code(302).header('location', `${redirectUri}?code=${encodeURIComponent(value)}&state=${encodeURIComponent(state)}`).send();
    });

    platform.post('/token', async (request, reply) => {
      oauth.tokenRequests += 1;
      const params = new URLSearchParams(String(request.body ?? ''));
      const code = oauth.code;
      if (!code
        || params.get('grant_type') !== 'authorization_code'
        || params.get('code') !== code.value
        || params.get('redirect_uri') !== code.redirectUri
        || !params.get('code_verifier')) {
        reply.code(400);
        return { error: 'invalid_grant' };
      }
      const verifier = params.get('code_verifier');
      if (!verifier) {
        reply.code(400);
        return { error: 'invalid_code_verifier' };
      }
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== code.codeChallenge) {
        reply.code(400);
        return { error: 'invalid_code_verifier' };
      }
      return {
        access_token: 'stub-antigravity-access-token',
        refresh_token: 'stub-antigravity-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email aicode',
      };
    });

    platform.post('/internal/provider/oauth/antigravity/start', async (request, reply) => {
      if (request.headers['x-provider-node-id'] !== nodeId || request.headers['x-provider-node-secret'] !== providerSecret) {
        reply.code(401);
        return { error: { code: 'invalid_provider_secret', message: 'Invalid provider node credentials' } };
      }
      if (!oauth.riskAccepted) {
        reply.code(400);
        return { error: { code: 'antigravity_risk_terms_required', message: 'Risk confirmation required' } };
      }
      const body = request.body as Record<string, unknown>;
      expect(body.protocolVersion).toBe(1);
      expect(body.flow).toBe('authorization_code');
      const flowId = `e2e-flow-${randomBytes(8).toString('hex')}`;
      const state = randomBytes(24).toString('base64url');
      const codeVerifier = randomBytes(48).toString('base64url');
      const redirectUri = typeof body.redirectUri === 'string' && body.redirectUri ? body.redirectUri : 'http://localhost:1455/auth/callback';
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: 'stub-google-client',
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      const authorizationUrl = `${oauthBaseUrl}/authorize?${query.toString()}`;
      oauth.flow = { flowId, state, codeVerifier, redirectUri, authorizationUrl };
      return { protocolVersion: 1, flowId, state, redirectUri, authorizationUrl, expiresAt: Date.now() + 600_000 };
    });

    platform.post('/internal/provider/oauth/antigravity/:flowId/exchange', async (request, reply) => {
      if (request.headers['x-provider-node-id'] !== nodeId || request.headers['x-provider-node-secret'] !== providerSecret) {
        reply.code(401);
        return { error: { code: 'invalid_provider_secret', message: 'Invalid provider node credentials' } };
      }
      const flow = oauth.flow;
      const body = request.body as Record<string, unknown>;
      if (!flow || request.params && (request.params as { flowId?: string }).flowId !== flow.flowId || body.protocolVersion !== 1 || body.state !== flow.state) {
        reply.code(400);
        return { error: { code: 'invalid_state', message: 'OAuth state mismatch' } };
      }
      const tokenResponse = await fetch(`${oauthBaseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(body.code ?? ''),
          redirect_uri: flow.redirectUri,
          code_verifier: flow.codeVerifier,
        }).toString(),
      });
      const token = await tokenResponse.json() as Record<string, unknown>;
      if (!tokenResponse.ok) {
        reply.code(tokenResponse.status);
        return { error: token };
      }
      oauth.boundCredential = {
        credentialBindingId: 'e2e-antigravity-credential',
        vendor: 'antigravity',
        credentialType: 'oauth',
        status: 'active',
        accountEmail: 'stub@example.test',
        accessTokenSource: 'antigravity_oauth_code',
      };
      return { protocolVersion: 1, flowId: flow.flowId, status: 'succeeded', credential: oauth.boundCredential };
    });

    const serverAddress = await platform.listen({ host: '127.0.0.1', port: 0 });
    platformPort = Number(new URL(serverAddress).port);
    oauthBaseUrl = `http://127.0.0.1:${platformPort}`;

    let csrf = '';
    try {
      csrf = await csrfToken();
      const config = await app.inject({ method: 'POST', url: '/api/config', headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': csrf }, payload: {
        nodeId,
        providerId,
        providerNodeSecret: providerSecret,
        platformWsUrl: `ws://127.0.0.1:${platformPort}`,
        runtimeMode: 'official_exit',
        officialExit: { enabled: true },
        capability: { model: 'gemini-4-argon', vendor: 'antigravity', routeMode: 'official_exit', supportsStreaming: true, supportsTools: true },
      } });
      expect(config.statusCode).toBe(200);

      const blocked = await app.inject({ method: 'POST', url: '/api/oauth/antigravity/start', headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': csrf }, payload: {} });
      expect(blocked.statusCode).toBe(400);
      expect(JSON.parse(blocked.body).error).toBe('antigravity_risk_terms_required');

      oauth.riskAccepted = true;
      const started = await app.inject({ method: 'POST', url: '/api/oauth/antigravity/browser/start', headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': csrf }, payload: {} });
      expect(started.statusCode).toBe(200);
      const startBody = JSON.parse(started.body) as { authorizationUrl: string; flowId: string; state: string };
      expect(new URL(startBody.authorizationUrl).hostname).toBe('127.0.0.1');
      expect(startBody.flowId).toBe(oauth.flow?.flowId);
      expect(startBody.state).toBe(oauth.flow?.state);

      const callback = await fetch(startBody.authorizationUrl, { redirect: 'manual' });
      expect(callback.status).toBe(302);
      const callbackUrl = new URL(callback.headers.get('location') ?? '');
      expect(callbackUrl.searchParams.get('state')).toBe(startBody.state);
      const code = callbackUrl.searchParams.get('code');
      expect(code).toBeTruthy();

      const callbackResponse = await fetch(callbackUrl, { redirect: 'manual' });
      expect(callbackResponse.status).toBe(200);
      const callbackHtml = await callbackResponse.text();
      expect(callbackHtml).toContain('Google Antigravity connected');
      expect(callbackHtml).toContain('window.close()');
      expect(callbackHtml).toContain('3000');
      const browserStatus = await app.inject({ method: 'GET', url: '/api/oauth/antigravity/browser/status', headers: { host: HOST } });
      expect(JSON.parse(browserStatus.body)).toMatchObject({ ok: true, status: 'succeeded' });
      expect(oauth.tokenRequests).toBe(1);
      expect(oauth.boundCredential).toBeDefined();
    } finally {
      await app.inject({ method: 'POST', url: '/api/oauth/antigravity/browser/stop', headers: { host: HOST, 'content-type': 'application/json', 'x-wokey-csrf': csrf }, payload: {} });
      await platform.close();
    }
  });
});
