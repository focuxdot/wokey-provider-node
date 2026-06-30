import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isConcreteClaudeSubscriptionType, normalizeClaudeSubscriptionType, subscriptionPlanDisplayName } from '../shared/subscription-plan.js';
import type { ProviderOAuthConfig } from './config.js';

interface ClaudeCodeCredentialsPayload {
  claudeAiOauth?: ClaudeCodeOAuthPayload;
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  id_token?: string;
  idToken?: string;
  expires_at?: number | string;
  expiresAt?: number | string;
  scope?: string;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeCodeOAuthPayload {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  id_token?: string;
  idToken?: string;
  expires_at?: number | string;
  expiresAt?: number | string;
  scope?: string;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeCodeConfigPayload {
  userID?: string;
  oauthAccount?: {
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    organizationType?: string;
    organizationRateLimitTier?: string;
    userRateLimitTier?: string;
  };
}

export interface ClaudeCodeOAuthMetadata {
  accountEmail?: string;
  organizationId?: string;
  subscriptionType?: string;
  claudeCodeUserId?: string;
  claudeCodeAccountUuid?: string;
}

export interface ClaudeCodeAuthDetection {
  path: string;
  exists: boolean;
  ready: boolean;
  requiresAuthorization?: boolean;
  accountEmail?: string;
  organizationId?: string;
  claudeCodeAccountUuid?: string;
  expiresAt?: number;
  subscriptionType?: string;
  subscriptionDisplayName?: string;
  error?: string;
}

export interface ClaudeCodeAuthDetectionOptions {
  readSecret?: boolean;
}

export function defaultClaudeCodeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

export function defaultClaudeCodeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export function importClaudeCodeOAuth(path?: string): ProviderOAuthConfig {
  const credentials = loadClaudeCodeOAuth(path);
  if (!credentials.accessToken || !credentials.refreshToken) {
    throw new Error('claude_code_credentials_missing_tokens');
  }
  return credentials;
}

export function detectClaudeCodeAuth(path?: string, options: ClaudeCodeAuthDetectionOptions = {}): ClaudeCodeAuthDetection {
  const configPath = resolveClaudeCodePath(path || defaultClaudeCodeConfigPath());
  const credentialsPath = resolveClaudeCodePath(path || defaultClaudeCodeCredentialsPath());
  const claudeDir = join(homedir(), '.claude');
  const exists = existsSync(configPath) || existsSync(credentialsPath) || existsSync(claudeDir);
  if (!exists) {
    return {
      path: configPath,
      exists: false,
      ready: false,
      error: 'claude_code_config_not_found',
    };
  }

  if (!options.readSecret) {
    const metadata = readClaudeCodeMetadata();
    return {
      path: path ? resolveClaudeCodePath(path) : claudeDir,
      exists: true,
      ready: false,
      requiresAuthorization: true,
      accountEmail: metadata.accountEmail,
      organizationId: metadata.organizationId,
      claudeCodeAccountUuid: metadata.claudeCodeAccountUuid,
      subscriptionType: metadata.subscriptionType,
      subscriptionDisplayName: subscriptionPlanDisplayName('anthropic', metadata.subscriptionType),
      error: 'claude_code_credentials_authorization_required',
    };
  }

  try {
    const oauth = importClaudeCodeOAuth(path);
    return {
      path: credentialsPathLabel(path),
      exists: true,
      ready: Boolean(oauth.accessToken && oauth.refreshToken),
      accountEmail: oauth.accountEmail,
      organizationId: oauth.organizationId,
      claudeCodeAccountUuid: oauth.claudeCodeAccountUuid,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      subscriptionDisplayName: oauth.subscriptionDisplayName,
    };
  } catch (error) {
    return {
      path: credentialsPathLabel(path),
      exists: true,
      ready: false,
      error: error instanceof Error ? error.message : 'claude_code_credentials_invalid',
    };
  }
}

function loadClaudeCodeOAuth(path?: string): ProviderOAuthConfig {
  const payload = readClaudeCodeCredentialsPayload(path);
  const oauthPayload = payload?.claudeAiOauth || payload;
  if (!oauthPayload) throw new Error('claude_code_credentials_not_found');

  const metadata = readClaudeCodeMetadata();
  const credentialSubscriptionType = normalizeClaudeSubscriptionType(
    stringValue(oauthPayload.rateLimitTier),
    stringValue(oauthPayload.subscriptionType),
  );
  const subscriptionType = isConcreteClaudeSubscriptionType(credentialSubscriptionType)
    ? credentialSubscriptionType
    : normalizeClaudeSubscriptionType(metadata.subscriptionType, credentialSubscriptionType);
  const scopes = Array.isArray(oauthPayload.scopes)
    ? oauthPayload.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];

  return {
    accessToken: stringValue(oauthPayload.accessToken) || stringValue(oauthPayload.access_token),
    refreshToken: stringValue(oauthPayload.refreshToken) || stringValue(oauthPayload.refresh_token),
    idToken: stringValue(oauthPayload.idToken) || stringValue(oauthPayload.id_token),
    tokenType: 'Bearer',
    expiresAt: parseExpiresAt(oauthPayload.expiresAt ?? oauthPayload.expires_at),
    scope: stringValue(oauthPayload.scope) || (scopes.length ? scopes.join(' ') : undefined),
    accountEmail: metadata.accountEmail,
    organizationId: metadata.organizationId,
    subscriptionType,
    subscriptionDisplayName: subscriptionPlanDisplayName('anthropic', subscriptionType),
    claudeCodeUserId: metadata.claudeCodeUserId,
    claudeCodeAccountUuid: metadata.claudeCodeAccountUuid,
  };
}

function readClaudeCodeCredentialsPayload(path?: string): ClaudeCodeCredentialsPayload | null {
  if (path) return readJsonFile<ClaudeCodeCredentialsPayload>(resolveClaudeCodePath(path));

  const credentialsPath = defaultClaudeCodeCredentialsPath();
  if (existsSync(credentialsPath)) return readJsonFile<ClaudeCodeCredentialsPayload>(credentialsPath);

  return null;
}

export function readClaudeCodeMetadata(): ClaudeCodeOAuthMetadata {
  const parsed = readJsonFile<ClaudeCodeConfigPayload>(defaultClaudeCodeConfigPath());
  const account = parsed?.oauthAccount;
  return {
    accountEmail: stringValue(account?.emailAddress),
    organizationId: stringValue(account?.organizationUuid) || stringValue(account?.accountUuid),
    claudeCodeUserId: stringValue(parsed?.userID),
    claudeCodeAccountUuid: stringValue(account?.accountUuid),
    subscriptionType: normalizeClaudeSubscriptionType(
      stringValue(account?.organizationRateLimitTier),
      stringValue(account?.userRateLimitTier),
      stringValue(account?.organizationType),
    ),
  };
}

export function applyClaudeCodeMetadataToOAuth(oauth: ProviderOAuthConfig): boolean {
  return applyClaudeCodeMetadata(oauth, readClaudeCodeMetadata());
}

export function applyClaudeCodeMetadata(oauth: ProviderOAuthConfig, metadata: ClaudeCodeOAuthMetadata): boolean {
  if (!metadata.subscriptionType) return false;
  const matchesAccount = [
    sameNormalizedValue(oauth.claudeCodeAccountUuid, metadata.claudeCodeAccountUuid),
    sameNormalizedValue(oauth.organizationId, metadata.organizationId),
    sameNormalizedValue(oauth.accountEmail, metadata.accountEmail),
  ].some(Boolean);
  if (!matchesAccount) return false;

  let changed = false;
  const subscriptionType = normalizeClaudeSubscriptionType(metadata.subscriptionType, oauth.subscriptionType);
  if (subscriptionType && oauth.subscriptionType !== subscriptionType) {
    oauth.subscriptionType = subscriptionType;
    oauth.subscriptionDisplayName = subscriptionPlanDisplayName('anthropic', subscriptionType);
    changed = true;
  } else if (subscriptionType && !oauth.subscriptionDisplayName) {
    oauth.subscriptionDisplayName = subscriptionPlanDisplayName('anthropic', subscriptionType);
    changed = true;
  }
  if (!oauth.claudeCodeUserId && metadata.claudeCodeUserId) {
    oauth.claudeCodeUserId = metadata.claudeCodeUserId;
    changed = true;
  }
  if (!oauth.claudeCodeAccountUuid && metadata.claudeCodeAccountUuid) {
    oauth.claudeCodeAccountUuid = metadata.claudeCodeAccountUuid;
    changed = true;
  }
  return changed;
}

function sameNormalizedValue(left?: string, right?: string): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function resolveClaudeCodePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function credentialsPathLabel(path?: string): string {
  if (path) return resolveClaudeCodePath(path);
  return defaultClaudeCodeCredentialsPath();
}

function parseExpiresAt(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return value < 100_000_000_000 ? value * 1000 : value;
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
