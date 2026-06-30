import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_OAUTH,
  CODEX_OAUTH,
  createAnthropicOAuthStart,
  createCodexOAuthStart,
  parseAnthropicAuthorizationCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
  verifyState,
} from '../src/provider-node/oauth.js';
import {
  providerOAuthConfigFromManualTokenBody,
  validateManualOAuthConfigForAuthorization,
} from '../src/provider-node/manual-oauth-token.js';

describe('provider OAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds Codex OAuth PKCE authorization URLs compatible with Codex CLI', () => {
    const flow = createCodexOAuthStart();
    const url = new URL(flow.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe(CODEX_OAUTH.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(CODEX_OAUTH.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CODEX_OAUTH.defaultRedirectUri);
    expect(url.searchParams.get('scope')).toBe(CODEX_OAUTH.scopes);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(flow.codeVerifier).toHaveLength(128);
    expect(verifyState(flow.state, url.searchParams.get('state') || '')).toBe(true);
  });

  it('requests Codex device codes using the official Codex device endpoint shape', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe(`${CODEX_OAUTH.issuer}/api/accounts/deviceauth/usercode`);
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: CODEX_OAUTH.clientId });
      return new Response(JSON.stringify({
        device_auth_id: 'device_auth_test',
        user_code: 'ABCD-EFGH',
        interval: '2',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deviceCode = await requestCodexDeviceCode();

    expect(deviceCode.verificationUrl).toBe(`${CODEX_OAUTH.issuer}/codex/device`);
    expect(deviceCode.userCode).toBe('ABCD-EFGH');
    expect(deviceCode.deviceAuthId).toBe('device_auth_test');
    expect(deviceCode.interval).toBe(2);
  });

  it('returns pending for Codex device code polling while the user has not approved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));

    await expect(pollCodexDeviceCode({
      deviceAuthId: 'device_auth_test',
      userCode: 'ABCD-EFGH',
    })).resolves.toEqual({ status: 'pending' });
  });

  it('returns pending for Codex device authorization_pending polling responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'authorization_pending',
      error_description: 'Authorization is still pending.',
    }), { status: 400 })));

    await expect(pollCodexDeviceCode({
      deviceAuthId: 'device_auth_test',
      userCode: 'ABCD-EFGH',
    })).resolves.toEqual({ status: 'pending' });
  });

  it('returns pending when Codex device polling has no authorization code yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'pending',
    }), { status: 200 })));

    await expect(pollCodexDeviceCode({
      deviceAuthId: 'device_auth_test',
      userCode: 'ABCD-EFGH',
    })).resolves.toEqual({ status: 'pending' });
  });

  it('builds Claude OAuth PKCE authorization URLs with Claude Code scopes', () => {
    const flow = createAnthropicOAuthStart();
    const url = new URL(flow.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe(ANTHROPIC_OAUTH.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(ANTHROPIC_OAUTH.redirectUri);
    expect(url.searchParams.get('scope')).toBe(ANTHROPIC_OAUTH.scopeOAuth);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(verifyState(flow.state, url.searchParams.get('state') || '')).toBe(true);
  });

  it('parses Claude authorization codes with fragment state', () => {
    expect(parseAnthropicAuthorizationCode('claude-code#state-value')).toEqual({
      code: 'claude-code',
      state: 'state-value',
    });
  });

  it('parses Claude callback URLs with fragment state', () => {
    expect(parseAnthropicAuthorizationCode('https://platform.claude.com/oauth/code/callback?code=claude-code#state-value')).toEqual({
      code: 'claude-code',
      state: 'state-value',
    });
  });

  it('parses Claude callback URLs with encoded code state', () => {
    expect(parseAnthropicAuthorizationCode('https://platform.claude.com/oauth/code/callback?code=claude-code%23state-value')).toEqual({
      code: 'claude-code',
      state: 'state-value',
    });
  });

  it('maps Claude manual token metadata to a subscription display name', () => {
    const oauth = providerOAuthConfigFromManualTokenBody({
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      rateLimitTier: 'default_claude_max_5x',
      oauthAccount: {
        accountUuid: 'claude-account-1',
        emailAddress: 'user@example.com',
      },
    }, 'anthropic');

    expect(oauth.subscriptionType).toBe('default_claude_max_5x');
    expect(oauth.subscriptionDisplayName).toBe('Claude Max 5x');
    expect(oauth.claudeCodeAccountUuid).toBe('claude-account-1');
    expect(oauth.accountEmail).toBe('user@example.com');
  });

  it('ignores Claude billingType payment-channel metadata when deriving a plan', () => {
    const paymentOnly = providerOAuthConfigFromManualTokenBody({
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      billingType: 'apple_subscription',
    }, 'anthropic');
    expect(paymentOnly.subscriptionType).toBeUndefined();

    const organizationFallback = providerOAuthConfigFromManualTokenBody({
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      billingType: 'apple_subscription',
      organizationType: 'team',
    }, 'anthropic');
    expect(organizationFallback.subscriptionType).toBe('team');
    expect(organizationFallback.subscriptionDisplayName).toBe('Claude Team');
  });

  it('maps snake_case Claude OAuth exports to account identity', () => {
    const oauth = providerOAuthConfigFromManualTokenBody({
      access_token: 'anthropic-access',
      refresh_token: 'anthropic-refresh',
      organization_id: 'org_1',
      account_email: 'user@example.com',
      claude_code_user_id: 'user_1',
      claude_code_account_uuid: 'account_1',
      subscription_type: 'pro',
      subscription_display_name: 'Claude Pro',
    }, 'anthropic');

    expect(oauth.accessToken).toBe('anthropic-access');
    expect(oauth.refreshToken).toBe('anthropic-refresh');
    expect(oauth.organizationId).toBe('org_1');
    expect(oauth.accountEmail).toBe('user@example.com');
    expect(oauth.claudeCodeUserId).toBe('user_1');
    expect(oauth.claudeCodeAccountUuid).toBe('account_1');
    expect(oauth.subscriptionType).toBe('pro');
    expect(oauth.subscriptionDisplayName).toBe('Claude Pro');
  });

  it('maps Codex manual token JWT claims to a subscription display name', () => {
    const idToken = unsignedJwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'chatgpt-account-1',
        chatgpt_plan_type: 'prolite',
      },
    });

    const oauth = providerOAuthConfigFromManualTokenBody({
      accessToken: 'codex-access',
      refreshToken: 'codex-refresh',
      idToken,
    }, 'openai');

    expect(oauth.subscriptionType).toBe('prolite');
    expect(oauth.subscriptionDisplayName).toBe('Codex Pro 5x');
    expect(oauth.organizationId).toBe('chatgpt-account-1');
    expect(oauth.accountEmail).toBe('user@example.com');
  });

  it('maps Codex auth.json-shaped manual token imports to account identity', () => {
    const accessToken = unsignedJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'prolite',
      },
    });
    const idToken = unsignedJwt({
      email: 'user@example.com',
      'https://api.openai.com/profile': {
        email: 'profile@example.com',
      },
    });

    const oauth = providerOAuthConfigFromManualTokenBody({
      tokens: {
        access_token: accessToken,
        refresh_token: 'codex-refresh',
        id_token: idToken,
        account_id: 'chatgpt-account-1',
      },
    }, 'openai');

    expect(oauth.accessToken).toBe(accessToken);
    expect(oauth.refreshToken).toBe('codex-refresh');
    expect(oauth.idToken).toBe(idToken);
    expect(oauth.organizationId).toBe('chatgpt-account-1');
    expect(oauth.accountEmail).toBe('user@example.com');
    expect(oauth.subscriptionType).toBe('prolite');
    expect(oauth.subscriptionDisplayName).toBe('Codex Pro 5x');
  });

  it('rejects OpenAI manual authorization without a refresh token', () => {
    const oauth = providerOAuthConfigFromManualTokenBody({
      accessToken: 'codex-access-only',
    }, 'openai');

    expect(() => validateManualOAuthConfigForAuthorization(oauth, 'openai'))
      .toThrow('oauth_refresh_token_required');
  });

  it('accepts Codex auth.json-shaped manual authorization with a refresh token', () => {
    const oauth = providerOAuthConfigFromManualTokenBody({
      tokens: {
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
      },
    }, 'openai');

    expect(() => validateManualOAuthConfigForAuthorization(oauth, 'openai'))
      .not.toThrow();
  });

});

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
}
