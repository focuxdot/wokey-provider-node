import { describe, expect, it } from 'vitest';
import {
  applyLocalCredentialBindingReference,
  localCredentialIdentityFingerprint,
  type LocalCredentialDetection,
} from '../src/provider-node/local-auth-detect.js';

const detection: LocalCredentialDetection = {
  id: 'claude-code',
  vendor: 'anthropic',
  source: 'claude-code',
  label: 'Claude Code',
  status: 'ready',
  canImport: true,
  claudeCodeAccountUuid: ' Account_1 ',
  accountEmail: 'provider@example.com',
};

describe('local credential binding references', () => {
  it('restores a local credential id for the same normalized account identity', () => {
    const identityFingerprint = localCredentialIdentityFingerprint(detection);
    expect(identityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (!identityFingerprint) throw new Error('identity fingerprint missing');
    expect(applyLocalCredentialBindingReference(
      { ...detection, claudeCodeAccountUuid: 'account_1' },
      { credentialBindingId: '42', identityFingerprint },
    ).credentialBindingId).toBe('42');
  });

  it('does not reuse the binding when the local account changes', () => {
    const identityFingerprint = localCredentialIdentityFingerprint(detection);
    if (!identityFingerprint) throw new Error('identity fingerprint missing');
    expect(applyLocalCredentialBindingReference(
      { ...detection, claudeCodeAccountUuid: 'account_2' },
      { credentialBindingId: '42', identityFingerprint },
    ).credentialBindingId).toBeUndefined();
  });
});
