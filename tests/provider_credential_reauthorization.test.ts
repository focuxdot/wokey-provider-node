import { describe, expect, it } from 'vitest';
import { inferManualReauthorizationCredentialIdFromPlatformCredentials } from '../src/provider-node/credential-reauthorization.js';

describe('provider credential reauthorization', () => {
  it('reuses the only disabled same-node vendor credential when a pasted token has no account identity', () => {
    const credentialId = inferManualReauthorizationCredentialIdFromPlatformCredentials(
      { vendor: 'anthropic', accessToken: 'access', refreshToken: 'refresh' },
      [
        { credentialBindingId: '4', vendor: 'anthropic', status: 'disabled', authorizedNodeIds: ['node_a', 'node_b'] },
        { credentialBindingId: '7', vendor: 'openai', status: 'active', authorizedNodeIds: ['node_b'] },
        { credentialBindingId: '10', vendor: 'anthropic', status: 'revoked', authorizedNodeIds: ['node_b'] },
      ],
      'node_b',
    );

    expect(credentialId).toBe('4');
  });

  it('does not guess when the pasted token already carries account identity', () => {
    const credentialId = inferManualReauthorizationCredentialIdFromPlatformCredentials(
      { vendor: 'anthropic', accessToken: 'access', refreshToken: 'refresh', claudeCodeAccountUuid: 'account_1' },
      [
        { credentialBindingId: '4', vendor: 'anthropic', status: 'disabled', authorizedNodeIds: ['node_b'] },
      ],
      'node_b',
    );

    expect(credentialId).toBeUndefined();
  });

  it('does not guess when multiple disabled same-vendor credentials are authorized on the same node', () => {
    const credentialId = inferManualReauthorizationCredentialIdFromPlatformCredentials(
      { vendor: 'anthropic', accessToken: 'access', refreshToken: 'refresh' },
      [
        { credentialBindingId: '4', vendor: 'anthropic', status: 'disabled', authorizedNodeIds: ['node_b'] },
        { credentialBindingId: '5', vendor: 'anthropic', status: 'paused', authorizedNodeIds: ['node_b'] },
      ],
      'node_b',
    );

    expect(credentialId).toBeUndefined();
  });
});
