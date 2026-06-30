import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ProviderOAuthConfig } from './config.js';

// Vendor OAuth client parameters. These mirror the official first-party CLI
// clients (public OAuth clients — no client secret). The `userAgent`/`originator`
// values must track the upstream CLI versions the vendors expect; bump them when
// the official codex/claude CLIs update, or token endpoints may reject the flow.
export const CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  issuer: 'https://auth.openai.com',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  defaultRedirectUri: 'http://localhost:1455/auth/callback',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  refreshScopes: 'openid profile email',
  originator: 'codex_cli_rs',
  userAgent: 'codex-cli/0.91.0',
} as const;

export const ANTHROPIC_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  claudeBaseUrl: 'https://claude.ai',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopeOAuth: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  scopeApi: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  scopeInference: 'user:inference',
  userAgent: 'axios/1.13.6',
} as const;

export interface OAuthStart {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  organization?: { uuid?: string };
  account?: { email_address?: string };
}

export interface AnthropicAuthorizationCodeParts {
  code: string;
  state?: string;
}

export interface CodexDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
  expiresAt: number;
}

interface CodexDeviceUserCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface CodexDevicePollResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = text ? JSON.parse(text) : undefined;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function isCodexDevicePollingPending(status: number, body: Record<string, unknown> | undefined, text: string): boolean {
  if (status === 403 || status === 404) return true;
  if (status === 400 && !text.trim()) return true;
  if (![400, 401, 409, 429].includes(status)) return false;

  const message = [
    stringField(body, 'error'),
    stringField(body, 'error_description'),
    stringField(body, 'message'),
    text,
  ]
    .join(' ')
    .toLowerCase();
  return /authorization[_ -]?pending|slow[_ -]?down|device_auth_not_found|not[_ -]?authorized|not ready|pending|try again/.test(
    message,
  );
}

async function parseCodexDevicePollResponse(response: Response): Promise<CodexDevicePollResponse | null> {
  const text = await response.text();
  const body = parseJsonRecord(text);

  if (!response.ok) {
    if (isCodexDevicePollingPending(response.status, body, text)) return null;
    throw new Error(`oauth_${response.status}:${text.slice(0, 300)}`);
  }

  const authorizationCode = stringField(body, 'authorization_code');
  const codeVerifier = stringField(body, 'code_verifier');
  if (!authorizationCode || !codeVerifier) return null;

  return {
    authorization_code: authorizationCode,
    code_challenge: stringField(body, 'code_challenge'),
    code_verifier: codeVerifier,
  };
}

export function createCodexOAuthStart(redirectUri: string = CODEX_OAUTH.defaultRedirectUri): OAuthStart {
  const state = randomBytes(32).toString('hex');
  const codeVerifier = randomBytes(64).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH.clientId,
    redirect_uri: redirectUri,
    scope: CODEX_OAUTH.scopes,
    state,
    code_challenge: createCodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_OAUTH.originator,
  });

  return {
    authorizationUrl: `${CODEX_OAUTH.authorizeUrl}?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri,
  };
}

export async function exchangeCodexCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH.clientId,
    code: input.code,
    redirect_uri: input.redirectUri || CODEX_OAUTH.defaultRedirectUri,
    code_verifier: input.codeVerifier,
  });

  return postForm(CODEX_OAUTH.tokenUrl, params, CODEX_OAUTH.userAgent);
}

export async function requestCodexDeviceCode(issuer: string = CODEX_OAUTH.issuer): Promise<CodexDeviceCode> {
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const response = await fetch(`${normalizedIssuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': CODEX_OAUTH.userAgent,
    },
    body: JSON.stringify({ client_id: CODEX_OAUTH.clientId }),
  });
  const raw = await parseResponse<CodexDeviceUserCodeResponse>(response);
  const userCode = raw.user_code || raw.usercode;
  if (!raw.device_auth_id || !userCode) throw new Error('codex_device_missing_user_code');
  const interval = Number(raw.interval || 5);
  return {
    verificationUrl: `${normalizedIssuer}/codex/device`,
    userCode,
    deviceAuthId: raw.device_auth_id,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
}

export async function pollCodexDeviceCode(input: {
  deviceAuthId: string;
  userCode: string;
  issuer?: string;
}): Promise<{ status: 'pending' } | { status: 'succeeded'; token: OAuthTokenResponse }> {
  const issuer = (input.issuer || CODEX_OAUTH.issuer).replace(/\/+$/, '');
  const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': CODEX_OAUTH.userAgent,
    },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });

  const code = await parseCodexDevicePollResponse(response);
  if (!code) return { status: 'pending' };

  const token = await exchangeCodexCode({
    code: code.authorization_code,
    codeVerifier: code.code_verifier,
    redirectUri: `${issuer}/deviceauth/callback`,
  });
  return { status: 'succeeded', token };
}

export function createAnthropicOAuthStart(scope: string = ANTHROPIC_OAUTH.scopeOAuth): OAuthStart {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: ANTHROPIC_OAUTH.redirectUri,
    scope,
    code_challenge: createCodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
  });

  return {
    authorizationUrl: `${ANTHROPIC_OAUTH.authorizeUrl}?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri: ANTHROPIC_OAUTH.redirectUri,
  };
}

export async function exchangeAnthropicCode(input: {
  code: string;
  codeVerifier: string;
  setupToken?: boolean;
}): Promise<OAuthTokenResponse> {
  const { code, state } = parseAnthropicAuthorizationCode(input.code);
  const body: Record<string, string | number> = {
    code,
    grant_type: 'authorization_code',
    client_id: ANTHROPIC_OAUTH.clientId,
    redirect_uri: ANTHROPIC_OAUTH.redirectUri,
    code_verifier: input.codeVerifier,
  };
  if (state) body.state = state;
  if (input.setupToken) body.expires_in = 31_536_000;

  return postJson(ANTHROPIC_OAUTH.tokenUrl, body, ANTHROPIC_OAUTH.userAgent);
}

export function parseAnthropicAuthorizationCode(raw: string): AnthropicAuthorizationCodeParts {
  const value = String(raw || '').trim();
  if (!value) return { code: '' };

  try {
    const url = new URL(value);
    const code = url.searchParams.get('code') || '';
    const queryState = url.searchParams.get('state') || undefined;
    const hashState = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
    const parsedCode = splitAnthropicCodeAndState(code);
    return {
      code: parsedCode.code || value,
      state: parsedCode.state || queryState || hashState,
    };
  } catch (_error) {
    const paramsText = value.startsWith('?') ? value.slice(1) : value;
    const params = new URLSearchParams(paramsText);
    const code = params.get('code') || '';
    if (code) {
      const parsedCode = splitAnthropicCodeAndState(code);
      return {
        code: parsedCode.code,
        state: parsedCode.state || params.get('state') || undefined,
      };
    }
  }

  return splitAnthropicCodeAndState(value);
}

export function formatAnthropicAuthorizationCode(parts: AnthropicAuthorizationCodeParts): string {
  return parts.state ? `${parts.code}#${parts.state}` : parts.code;
}

function splitAnthropicCodeAndState(value: string): AnthropicAuthorizationCodeParts {
  const index = value.indexOf('#');
  if (index === -1) return { code: value };
  return {
    code: value.slice(0, index),
    state: value.slice(index + 1) || undefined,
  };
}

export function applyTokenToOAuthConfig(oauth: ProviderOAuthConfig, token: OAuthTokenResponse): void {
  const receivedAt = new Date().toISOString();
  oauth.accessToken = token.access_token || oauth.accessToken;
  oauth.refreshToken = token.refresh_token || oauth.refreshToken;
  oauth.idToken = token.id_token || oauth.idToken;
  oauth.tokenType = token.token_type || oauth.tokenType || 'Bearer';
  oauth.scope = token.scope || oauth.scope;
  oauth.expiresAt = token.expires_in ? Date.now() + (token.expires_in * 1000) : oauth.expiresAt;
  oauth.organizationId = token.organization?.uuid || oauth.organizationId;
  oauth.accountEmail = token.account?.email_address || oauth.accountEmail;
  oauth.accessTokenReceivedAt = receivedAt;
}

export function verifyState(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

async function postForm(url: string, params: URLSearchParams, userAgent: string): Promise<OAuthTokenResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent,
    },
    body: params.toString(),
  });
  return parseResponse<OAuthTokenResponse>(response);
}

async function postJson(url: string, body: unknown, userAgent: string): Promise<OAuthTokenResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': userAgent,
    },
    body: JSON.stringify(body),
  });
  return parseResponse<OAuthTokenResponse>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html') || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
      throw new Error(`oauth_${response.status}:anthropic_browser_session_challenge`);
    }
    throw new Error(`oauth_${response.status}:${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}
