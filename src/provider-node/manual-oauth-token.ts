import { subscriptionPlanDisplayName, normalizeClaudeSubscriptionType } from '../shared/subscription-plan.js';
import type { ProviderOAuthConfig } from './config.js';

type AnyRecord = Record<string, unknown>;

export function providerOAuthConfigFromManualTokenBody(
  body: AnyRecord,
  vendor: 'openai' | 'anthropic',
): ProviderOAuthConfig {
  const tokens = nestedRecord(body.tokens);
  const accessToken = stringValue(body.accessToken) || stringValue(body.access_token) || stringValue(tokens?.access_token);
  const refreshToken = stringValue(body.refreshToken) || stringValue(body.refresh_token) || stringValue(tokens?.refresh_token);
  const idToken = stringValue(body.idToken) || stringValue(body.id_token) || stringValue(tokens?.id_token);
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);
  const openAiAuthClaims = openAiAuthClaimsFrom(idClaims) || openAiAuthClaimsFrom(accessClaims);
  const openAiProfile = recordField(idClaims['https://api.openai.com/profile']);
  const oauthAccount = nestedRecord(body.oauthAccount);
  const subscriptionType = manualTokenSubscriptionType(body, vendor, accessClaims, idClaims);

  return {
    accessToken,
    refreshToken,
    idToken,
    tokenType: stringValue(body.tokenType) || stringValue(body.token_type) || 'Bearer',
    expiresAt: parseManualTokenExpiresAt(body.expiresAt ?? body.expires_at, body.expiresIn ?? body.expires_in),
    scope: stringValue(body.scope),
    organizationId: stringValue(body.organizationId)
      || stringValue(body.organization_id)
      || stringValue(nestedRecord(body.organization)?.uuid)
      || stringValue(oauthAccount?.organizationUuid)
      || stringValue(oauthAccount?.accountUuid)
      || stringValue(openAiAuthClaims?.chatgpt_account_id)
      || stringValue(tokens?.account_id),
    accountEmail: stringValue(body.accountEmail)
      || stringValue(body.account_email)
      || stringValue(nestedRecord(body.account)?.email_address)
      || stringValue(oauthAccount?.emailAddress)
      || stringValue(idClaims.email)
      || stringValue(openAiProfile?.email),
    subscriptionType,
    subscriptionDisplayName: stringValue(body.subscriptionDisplayName)
      || stringValue(body.subscription_display_name)
      || subscriptionPlanDisplayName(vendor, subscriptionType),
    claudeCodeUserId: stringValue(body.claudeCodeUserId) || stringValue(body.claude_code_user_id) || stringValue(body.userID),
    claudeCodeAccountUuid: stringValue(body.claudeCodeAccountUuid) || stringValue(body.claude_code_account_uuid) || stringValue(nestedRecord(body.oauthAccount)?.accountUuid),
  };
}

export function validateManualOAuthConfigForAuthorization(
  oauth: ProviderOAuthConfig,
  vendor: 'openai' | 'anthropic',
): void {
  if (!oauth.accessToken) throw new Error('oauth_access_token_missing');
  if (vendor === 'openai' && !oauth.refreshToken) throw new Error('oauth_refresh_token_required');
}

function manualTokenSubscriptionType(
  body: AnyRecord,
  vendor: 'openai' | 'anthropic',
  accessClaims: AnyRecord,
  idClaims: AnyRecord,
): string | undefined {
  if (vendor === 'anthropic') {
    const oauthAccount = nestedRecord(body.oauthAccount);
    return normalizeClaudeSubscriptionType(
      stringValue(body.rateLimitTier),
      stringValue(body.organizationRateLimitTier) || stringValue(oauthAccount?.organizationRateLimitTier),
      stringValue(body.userRateLimitTier) || stringValue(oauthAccount?.userRateLimitTier),
      stringValue(body.subscriptionType) || stringValue(body.subscription_type),
      stringValue(body.organizationType) || stringValue(oauthAccount?.organizationType),
      stringValue(accessClaims.rateLimitTier),
      stringValue(accessClaims.subscriptionType),
    );
  }

  return stringValue(body.subscriptionType)
    || stringValue(body.subscription_type)
    || stringValue(body.chatgptPlanType)
    || stringValue(body.chatgpt_plan_type)
    || stringValue(openAiAuthClaimsFrom(idClaims)?.chatgpt_plan_type)
    || stringValue(openAiAuthClaimsFrom(accessClaims)?.chatgpt_plan_type);
}

function parseManualTokenExpiresAt(expiresAt: unknown, expiresIn: unknown): number | undefined {
  const absolute = numberValue(expiresAt);
  if (absolute !== undefined) return absolute;
  const relativeSeconds = numberValue(expiresIn);
  return relativeSeconds && relativeSeconds > 0 ? Date.now() + relativeSeconds * 1000 : undefined;
}

function decodeJwtPayload(jwt?: string): AnyRecord {
  const parts = jwt?.split('.') || [];
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AnyRecord;
  } catch {
    return {};
  }
}

function openAiAuthClaimsFrom(claims: AnyRecord): AnyRecord | undefined {
  return recordField(claims['https://api.openai.com/auth']);
}

function nestedRecord(value: unknown): AnyRecord | undefined {
  return recordField(value);
}

function recordField(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
