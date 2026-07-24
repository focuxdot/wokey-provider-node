import { createHash } from 'node:crypto';
import { detectClaudeCodeAuth } from './claude-code-auth.js';
import { detectCodexAuthJson } from './codex-auth-json.js';

export type LocalCredentialDetectionStatus = 'ready' | 'requires_authorization' | 'unavailable' | 'error';

export interface LocalCredentialDetection {
  id: string;
  vendor: 'openai' | 'anthropic';
  source: 'codex-auth-json' | 'claude-code';
  label: string;
  path?: string;
  status: LocalCredentialDetectionStatus;
  canImport: boolean;
  accountEmail?: string;
  organizationId?: string;
  claudeCodeAccountUuid?: string;
  expiresAt?: number;
  subscriptionType?: string;
  subscriptionDisplayName?: string;
  reason?: string;
  credentialBindingId?: string;
}

export interface LocalCredentialBindingReference {
  credentialBindingId: string;
  identityFingerprint: string;
}

export function detectLocalCredentials(): LocalCredentialDetection[] {
  return [
    detectCodexCredential(),
    detectClaudeCodeCredential(),
  ];
}

export function applyLocalCredentialBindingReference(
  detection: LocalCredentialDetection,
  binding: LocalCredentialBindingReference | undefined,
): LocalCredentialDetection {
  if (!binding || binding.identityFingerprint !== localCredentialIdentityFingerprint(detection)) return detection;
  return { ...detection, credentialBindingId: binding.credentialBindingId };
}

export function localCredentialIdentityFingerprint(
  value: Pick<LocalCredentialDetection, 'claudeCodeAccountUuid' | 'organizationId' | 'accountEmail'>,
): string | undefined {
  const identity = [
    ['claudeCodeAccountUuid', value.claudeCodeAccountUuid],
    ['organizationId', value.organizationId],
    ['accountEmail', value.accountEmail],
  ]
    .map(([kind, raw]) => [kind, typeof raw === 'string' ? raw.trim().toLowerCase() : ''] as const)
    .find(([, normalized]) => Boolean(normalized));
  if (!identity) return undefined;
  return createHash('sha256').update(`${identity[0]}:${identity[1]}`).digest('hex');
}

function detectCodexCredential(): LocalCredentialDetection {
  const detected = detectCodexAuthJson();
  return {
    id: 'codex-auth-json',
    vendor: 'openai',
    source: 'codex-auth-json',
    label: 'Codex auth.json',
    path: detected.path,
    status: detected.ready ? 'ready' : detected.exists ? 'error' : 'unavailable',
    canImport: detected.ready,
    accountEmail: detected.accountEmail,
    organizationId: detected.organizationId,
    expiresAt: detected.expiresAt,
    subscriptionType: detected.subscriptionType,
    subscriptionDisplayName: detected.subscriptionDisplayName,
    reason: detected.ready ? undefined : detected.error,
  };
}

function detectClaudeCodeCredential(): LocalCredentialDetection {
  const detected = detectClaudeCodeAuth();
  return {
    id: 'claude-code',
    vendor: 'anthropic',
    source: 'claude-code',
    label: 'Claude Code',
    path: detected.path,
    status: detected.ready ? 'ready' : detected.requiresAuthorization ? 'requires_authorization' : detected.exists ? 'error' : 'unavailable',
    canImport: detected.ready || Boolean(detected.requiresAuthorization),
    accountEmail: detected.accountEmail,
    organizationId: detected.organizationId,
    claudeCodeAccountUuid: detected.claudeCodeAccountUuid,
    expiresAt: detected.expiresAt,
    subscriptionType: detected.subscriptionType,
    subscriptionDisplayName: detected.subscriptionDisplayName,
    reason: detected.ready ? undefined : detected.error,
  };
}
