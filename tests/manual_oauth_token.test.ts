import { describe, expect, it } from 'vitest';
import {
  providerOAuthConfigFromManualTokenBody,
  validateManualOAuthConfigForAuthorization,
} from '../src/provider-node/manual-oauth-token.js';

describe('manual OAuth token imports', () => {
  it('maps Claude metadata while ignoring billingType as a plan signal', () => {
    const oauth = providerOAuthConfigFromManualTokenBody({
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      rateLimitTier: 'default_claude_max_5x',
      billingType: 'apple_subscription',
      oauthAccount: {
        accountUuid: 'claude-account-1',
        emailAddress: 'user@example.com',
      },
    }, 'anthropic');
    expect(oauth).toMatchObject({
      subscriptionType: 'default_claude_max_5x',
      subscriptionDisplayName: 'Claude Max 5x',
      claudeCodeAccountUuid: 'claude-account-1',
      accountEmail: 'user@example.com',
    });

    const paymentOnly = providerOAuthConfigFromManualTokenBody({
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      billingType: 'apple_subscription',
    }, 'anthropic');
    expect(paymentOnly.subscriptionType).toBeUndefined();
  });

  it('maps Codex auth.json-shaped imports and requires a refresh token', () => {
    const accessToken = unsignedJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite' },
    });
    const idToken = unsignedJwt({
      email: 'user@example.com',
      'https://api.openai.com/profile': { email: 'profile@example.com' },
    });
    const oauth = providerOAuthConfigFromManualTokenBody({
      tokens: {
        access_token: accessToken,
        refresh_token: 'codex-refresh',
        id_token: idToken,
        account_id: 'chatgpt-account-1',
      },
    }, 'openai');
    expect(oauth).toMatchObject({
      accessToken,
      refreshToken: 'codex-refresh',
      idToken,
      organizationId: 'chatgpt-account-1',
      accountEmail: 'user@example.com',
      subscriptionType: 'prolite',
      subscriptionDisplayName: 'Codex Pro 5x',
    });
    expect(() => validateManualOAuthConfigForAuthorization(oauth, 'openai')).not.toThrow();
    expect(() => validateManualOAuthConfigForAuthorization(
      providerOAuthConfigFromManualTokenBody({ accessToken: 'only-access' }, 'openai'),
      'openai',
    )).toThrow('oauth_refresh_token_required');
  });
});

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
}
