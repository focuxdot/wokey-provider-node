import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCursorOAuthLogin,
  createCursorDeviceIdentity,
  CursorAuthorizationHandler,
  type CursorAuthEvent,
} from '../src/provider-node/cursor-auth.js';
import {
  CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
  type PlatformCursorAuthStart,
} from '../src/shared/protocol.js';

const NOW_MS = 1_800_000_000_000;
const TEST_UUID = '123e4567-e89b-42d3-a456-426614174000';

function startMessage(): PlatformCursorAuthStart {
  return {
    type: 'platform.cursor_auth_start',
    protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-1',
    flowId: 'flow-1',
    providerId: 'provider-1',
    nodeId: 'node-1',
    deadlineMs: 30_000,
  };
}

function accessToken(claims: Record<string, unknown> = {}) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      sub: 'cursor-account-1',
      exp: Math.floor(NOW_MS / 1_000) + 3_600,
      ...claims,
    })).toString('base64url'),
    'signature',
  ].join('.');
}

function successfulResponse(claims?: Record<string, unknown>) {
  return new Response(JSON.stringify({
    accessToken: accessToken(claims),
    refreshToken: 'cursor-refresh-token',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('CursorAuthorizationHandler native OAuth', () => {
  it('reproduces Cursor verifier/challenge generation without Cursor Agent', () => {
    const entropy = Buffer.alloc(32, 7);
    const login = createCursorOAuthLogin({
      randomBytes: () => entropy,
      randomUuid: () => TEST_UUID,
    });
    const expectedVerifier = entropy.toString('base64url');
    const expectedChallenge = createHash('sha256').update(expectedVerifier).digest('base64url');
    const url = new URL(login.authorizationUrl);

    expect(login).toMatchObject({
      uuid: TEST_UUID,
      verifier: expectedVerifier,
      challenge: expectedChallenge,
    });
    expect(url.origin).toBe('https://cursor.com');
    expect(url.pathname).toBe('/loginDeepControl');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      challenge: expectedChallenge,
      uuid: TEST_UUID,
      mode: 'login',
      redirectTarget: 'cli',
    });
  });

  it('creates a persistent-format provider device identity without Cursor Desktop', () => {
    let fill = 1;
    const identity = createCursorDeviceIdentity((size) => Buffer.alloc(size, fill++));
    expect(identity).toEqual({
      machineId: '01'.repeat(32),
      macMachineId: '02'.repeat(32),
      version: '3.16.17',
    });
  });

  it('advertises native OAuth and completes after pending poll responses', async () => {
    const requests: URL[] = [];
    const requestInits: RequestInit[] = [];
    let polls = 0;
    const handler = new CursorAuthorizationHandler({
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      now: () => NOW_MS,
      randomBytes: () => Buffer.alloc(32, 9),
      randomUuid: () => TEST_UUID,
      sleep: async () => {},
      getDeviceIdentity: () => ({
        machineId: 'provider-machine-id',
        macMachineId: 'provider-mac-machine-id',
        version: '3.16.17',
      }),
      fetch: async (input, init) => {
        requests.push(new URL(input));
        requestInits.push(init ?? {});
        polls += 1;
        return polls === 1 ? new Response('', { status: 404 }) : successfulResponse();
      },
    });
    expect(handler.capability()).toEqual({
      protocolVersions: [1],
      implementation: 'native_oauth',
      implementationVersion: 'native-oauth-v1',
    });

    const events: CursorAuthEvent[] = [];
    handler.start(startMessage(), (event) => events.push(event));
    await expect.poll(() => events.length, { timeout: 5_000 }).toBe(2);
    expect(events[0]).toMatchObject({
      type: 'provider.cursor_auth_started',
      authorizationUrl: expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?/),
    });
    expect(events[0]).not.toHaveProperty('verifier');
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.origin === 'https://api2.cursor.sh')).toBe(true);
    expect(requests.every((url) => url.pathname === '/auth/poll')).toBe(true);
    expect(requests[0].searchParams.get('uuid')).toBe(TEST_UUID);
    expect(requests[0].searchParams.get('verifier')).toBeTruthy();
    expect(requestInits.every((init) => init.redirect === 'error')).toBe(true);

    const completed = events[1];
    if (completed.type !== 'provider.cursor_auth_completed') throw new Error('unexpected_event');
    expect(JSON.parse(completed.encodedCredentialBundle)).toEqual({
      version: 1,
      accessToken: accessToken(),
      refreshToken: 'cursor-refresh-token',
      expiresAt: NOW_MS + 3_600_000,
      accountId: 'cursor-account-1',
      authorizedClientVersion: '3.16.17',
      machineId: 'provider-machine-id',
      macMachineId: 'provider-mac-machine-id',
    });
  });

  it('cancels a pending native OAuth poll without local process cleanup', async () => {
    const handler = new CursorAuthorizationHandler({
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      now: () => NOW_MS,
      randomUuid: () => TEST_UUID,
      fetch: async () => new Response('', { status: 404 }),
      sleep: (_delayMs, signal) => new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const events: CursorAuthEvent[] = [];
    handler.start(startMessage(), (event) => events.push(event));
    await expect.poll(() => events.length).toBe(1);
    expect(handler.cancel({
      type: 'platform.cursor_auth_cancel',
      protocolVersion: 1,
      requestId: 'cancel-1',
      flowId: 'flow-1',
      nodeId: 'node-1',
    })).toBe(true);
    await expect.poll(() => events.length).toBe(2);
    expect(events[1]).toMatchObject({
      type: 'provider.cursor_auth_failed',
      errorCode: 'cursor_auth_cancelled',
      retryable: false,
    });
  });

  it('fails closed after bounded network failures', async () => {
    let attempts = 0;
    const handler = new CursorAuthorizationHandler({
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      now: () => NOW_MS,
      randomUuid: () => TEST_UUID,
      sleep: async () => {},
      fetch: async () => {
        attempts += 1;
        throw new Error('network details must not escape');
      },
    });
    const events: CursorAuthEvent[] = [];
    handler.start(startMessage(), (event) => events.push(event));
    await expect.poll(() => events.length).toBe(2);
    expect(attempts).toBe(3);
    expect(events[1]).toMatchObject({
      type: 'provider.cursor_auth_failed',
      errorCode: 'cursor_auth_poll_network_failed',
      retryable: true,
    });
    expect(events[1]).not.toHaveProperty('diagnostic');
  });

  it('rejects sign-in policy failures and invalid account identity', async () => {
    const policyHandler = new CursorAuthorizationHandler({
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      now: () => NOW_MS,
      randomUuid: () => TEST_UUID,
      fetch: async () => new Response(JSON.stringify({ error: 'sign_in_policy_violation' }), { status: 403 }),
    });
    const policyEvents: CursorAuthEvent[] = [];
    policyHandler.start(startMessage(), (event) => policyEvents.push(event));
    await expect.poll(() => policyEvents.length).toBe(2);
    expect(policyEvents[1]).toMatchObject({ errorCode: 'cursor_auth_sign_in_policy_violation' });

    const identityHandler = new CursorAuthorizationHandler({
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      getDeviceIdentity: () => ({
        machineId: 'provider-machine-id',
        macMachineId: 'provider-mac-machine-id',
        version: '3.16.17',
      }),
      now: () => NOW_MS,
      randomUuid: () => TEST_UUID,
      fetch: async () => successfulResponse({ sub: undefined }),
    });
    const identityEvents: CursorAuthEvent[] = [];
    identityHandler.start(startMessage(), (event) => identityEvents.push(event));
    await expect.poll(() => identityEvents.length).toBe(2);
    expect(identityEvents[1]).toMatchObject({
      type: 'provider.cursor_auth_failed',
      stage: 'credential_validation',
      errorCode: 'cursor_credential_account_id_missing',
    });
  });
});
