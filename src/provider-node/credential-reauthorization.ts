type CredentialSummary = Record<string, unknown>;

export function inferManualReauthorizationCredentialIdFromPlatformCredentials(
  credentialBody: Record<string, unknown>,
  credentials: unknown[],
  nodeId: string,
): string | undefined {
  if (typeof credentialBody.credentialBindingId === 'string' && credentialBody.credentialBindingId) return undefined;
  if (credentialHasAccountIdentity(credentialBody)) return undefined;
  const vendor = credentialBody.vendor;
  if (vendor !== 'openai' && vendor !== 'anthropic') return undefined;

  const candidates = credentials
    .filter((item): item is CredentialSummary => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .filter((item) => (
      item.vendor === vendor
      && ['disabled', 'paused'].includes(String(item.status || ''))
      && typeof item.credentialBindingId === 'string'
      && (!Array.isArray(item.authorizedNodeIds) || item.authorizedNodeIds.includes(nodeId))
    ));
  const credentialBindingId = candidates.length === 1 ? candidates[0]?.credentialBindingId : undefined;
  return typeof credentialBindingId === 'string' ? credentialBindingId : undefined;
}

function credentialHasAccountIdentity(credentialBody: Record<string, unknown>): boolean {
  return ['claudeCodeAccountUuid', 'organizationId', 'accountEmail']
    .some((key) => typeof credentialBody[key] === 'string' && Boolean(String(credentialBody[key]).trim()));
}
