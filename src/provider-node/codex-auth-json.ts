import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { subscriptionPlanDisplayName } from '../shared/subscription-plan.js';
import type { ProviderOAuthConfig } from './config.js';

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface CodexAuthClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
}

export function defaultCodexAuthJsonPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

export function resolveCodexAuthJsonPath(path?: string): string {
  if (!path || path.trim() === '') return defaultCodexAuthJsonPath();
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function importCodexAuthJson(path?: string): ProviderOAuthConfig {
  return loadCodexAuthJson(path).oauth;
}

function loadCodexAuthJson(path?: string): { oauth: ProviderOAuthConfig; subscriptionType?: string } {
  const resolvedPath = resolveCodexAuthJsonPath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`codex_auth_json_not_found:${resolvedPath}`);
  }

  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as CodexAuthJson;
  const tokens = parsed.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) {
    throw new Error('codex_auth_json_missing_tokens');
  }

  const accessClaims = decodeJwtPayload(tokens.access_token);
  const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  const profile = idClaims['https://api.openai.com/profile'] as { email?: string } | undefined;
  const idAuthClaims = idClaims['https://api.openai.com/auth'] as CodexAuthClaims | undefined;
  const accessAuthClaims = accessClaims['https://api.openai.com/auth'] as CodexAuthClaims | undefined;
  const authClaims = idAuthClaims || accessAuthClaims;
  const subscriptionType = idAuthClaims?.chatgpt_plan_type || accessAuthClaims?.chatgpt_plan_type;

  return {
    oauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      tokenType: 'Bearer',
      expiresAt: typeof accessClaims.exp === 'number' ? accessClaims.exp * 1000 : undefined,
      accountEmail: typeof idClaims.email === 'string' ? idClaims.email : profile?.email,
      organizationId: authClaims?.chatgpt_account_id || tokens.account_id,
      subscriptionType,
      subscriptionDisplayName: subscriptionPlanDisplayName('openai', subscriptionType),
    },
    subscriptionType,
  };
}

export interface CodexAuthJsonDetection {
  path: string;
  exists: boolean;
  ready: boolean;
  accountEmail?: string;
  organizationId?: string;
  expiresAt?: number;
  subscriptionType?: string;
  subscriptionDisplayName?: string;
  error?: string;
}

export function detectCodexAuthJson(path?: string): CodexAuthJsonDetection {
  const resolvedPath = resolveCodexAuthJsonPath(path);
  if (!existsSync(resolvedPath)) {
    return { path: resolvedPath, exists: false, ready: false, error: 'codex_auth_json_not_found' };
  }
  try {
    const { oauth, subscriptionType } = loadCodexAuthJson(resolvedPath);
    return {
      path: resolvedPath,
      exists: true,
      ready: Boolean(oauth.accessToken && oauth.refreshToken),
      accountEmail: oauth.accountEmail,
      organizationId: oauth.organizationId,
      expiresAt: oauth.expiresAt,
      ...(subscriptionType ? {
        subscriptionType,
        subscriptionDisplayName: subscriptionPlanDisplayName('openai', subscriptionType),
      } : {}),
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: true,
      ready: false,
      error: error instanceof Error ? error.message : 'codex_auth_json_invalid',
    };
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
