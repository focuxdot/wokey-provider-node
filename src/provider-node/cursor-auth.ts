import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  CursorAuthControlProtocolVersion,
  CursorAuthFailureStage,
  PlatformCursorAuthCancel,
  PlatformCursorAuthStart,
  ProviderCursorAuthCompleted,
  ProviderCursorAuthFailed,
  ProviderCursorAuthStarted,
} from '../shared/protocol.js';
import { CURSOR_AUTH_CONTROL_PROTOCOL_VERSION } from '../shared/protocol.js';

const CURSOR_WEBSITE_ORIGIN = 'https://cursor.com';
const CURSOR_API_ORIGIN = 'https://api2.cursor.sh';
const CURSOR_AUTH_POLL_PATH = '/auth/poll';
const CURSOR_AUTH_IMPLEMENTATION_VERSION = 'native-oauth-v1';
const CURSOR_AUTHORIZED_CLIENT_VERSION = '3.16.17';
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;

export type CursorAuthEvent =
  | ProviderCursorAuthStarted
  | ProviderCursorAuthCompleted
  | ProviderCursorAuthFailed;

interface RunningFlow {
  cancelled: boolean;
  expired: boolean;
  abortController: AbortController;
}

interface CursorOAuthLogin {
  uuid: string;
  verifier: string;
  challenge: string;
  authorizationUrl: string;
}

interface CursorOAuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface CursorDesktopIdentity {
  machineId: string;
  macMachineId?: string;
  version: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepLike = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface CursorAuthorizationHandlerOptions {
  getIdentity: () => { nodeId: string; providerId: string };
  fetch?: FetchLike;
  sleep?: SleepLike;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUuid?: () => string;
  getDeviceIdentity?: () => CursorDesktopIdentity;
}

export class CursorAuthorizationHandler {
  private readonly flows = new Map<string, RunningFlow>();
  private readonly now: () => number;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: SleepLike;

  constructor(private readonly options: CursorAuthorizationHandlerOptions) {
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleepFn = options.sleep ?? abortableSleep;
  }

  capability() {
    return {
      protocolVersions: [CURSOR_AUTH_CONTROL_PROTOCOL_VERSION],
      implementation: 'native_oauth' as const,
      implementationVersion: CURSOR_AUTH_IMPLEMENTATION_VERSION,
    } satisfies {
      protocolVersions: CursorAuthControlProtocolVersion[];
      implementation: 'native_oauth';
      implementationVersion: string;
    };
  }

  start(message: PlatformCursorAuthStart, emit: (event: CursorAuthEvent) => void): void {
    const identity = this.options.getIdentity();
    if (
      message.protocolVersion !== CURSOR_AUTH_CONTROL_PROTOCOL_VERSION
      || message.nodeId !== identity.nodeId
      || message.providerId !== identity.providerId
      || !message.flowId
      || this.flows.has(message.flowId)
      || this.flows.size > 0
    ) {
      emit(failedEvent(message, 'launch', 'cursor_auth_start_invalid', false));
      return;
    }
    const flow: RunningFlow = {
      cancelled: false,
      expired: false,
      abortController: new AbortController(),
    };
    this.flows.set(message.flowId, flow);
    void this.run(message, flow, emit).finally(() => this.flows.delete(message.flowId));
  }

  cancel(message: PlatformCursorAuthCancel): boolean {
    const identity = this.options.getIdentity();
    if (message.protocolVersion !== CURSOR_AUTH_CONTROL_PROTOCOL_VERSION || message.nodeId !== identity.nodeId) {
      return false;
    }
    const flow = this.flows.get(message.flowId);
    if (!flow) return false;
    flow.cancelled = true;
    flow.abortController.abort();
    return true;
  }

  cancelAll(): void {
    for (const flow of this.flows.values()) {
      flow.cancelled = true;
      flow.abortController.abort();
    }
  }

  private async run(
    message: PlatformCursorAuthStart,
    flow: RunningFlow,
    emit: (event: CursorAuthEvent) => void,
  ): Promise<void> {
    const deadlineMs = Math.max(1_000, Math.min(message.deadlineMs, 15 * 60_000));
    const expiresAtMs = this.now() + deadlineMs;
    let stage: CursorAuthFailureStage = 'browser_authorization';
    const timer = setTimeout(() => {
      flow.expired = true;
      flow.abortController.abort();
    }, deadlineMs);
    timer.unref?.();
    try {
      const login = createCursorOAuthLogin({
        randomBytes: this.options.randomBytes,
        randomUuid: this.options.randomUuid,
      });
      emit({
        type: 'provider.cursor_auth_started',
        protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        flowId: message.flowId,
        nodeId: message.nodeId,
        authorizationUrl: login.authorizationUrl,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      const tokens = await pollCursorOAuth({
        uuid: login.uuid,
        verifier: login.verifier,
        expiresAtMs,
        signal: flow.abortController.signal,
        fetchFn: this.fetchFn,
        sleepFn: this.sleepFn,
        now: this.now,
      });
      assertFlowActive(flow);
      stage = 'credential_validation';
      const deviceIdentity = this.options.getDeviceIdentity?.()
        ?? createCursorDeviceIdentity(this.options.randomBytes ?? randomBytes);
      const encodedCredentialBundle = encodeNativeCredentialBundle(tokens, deviceIdentity, this.now());
      emit({
        type: 'provider.cursor_auth_completed',
        protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        flowId: message.flowId,
        nodeId: message.nodeId,
        encodedCredentialBundle,
      });
    } catch (error) {
      emit(failedEvent(
        message,
        stage,
        cursorAuthErrorCode(error, flow),
        cursorAuthRetryable(error, flow),
        cursorAuthDiagnostic(error),
      ));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createCursorOAuthLogin(options: {
  randomBytes?: (size: number) => Buffer;
  randomUuid?: () => string;
} = {}): CursorOAuthLogin {
  const verifier = base64Url((options.randomBytes ?? randomBytes)(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const uuid = (options.randomUuid ?? randomUUID)();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new CursorNativeAuthError('cursor_auth_uuid_invalid', false);
  }
  const authorization = new URL('/loginDeepControl', CURSOR_WEBSITE_ORIGIN);
  authorization.searchParams.set('challenge', challenge);
  authorization.searchParams.set('uuid', uuid);
  authorization.searchParams.set('mode', 'login');
  authorization.searchParams.set('redirectTarget', 'cli');
  return { uuid, verifier, challenge, authorizationUrl: authorization.toString() };
}

export async function pollCursorOAuth(input: {
  uuid: string;
  verifier: string;
  expiresAtMs: number;
  signal: AbortSignal;
  fetchFn?: FetchLike;
  sleepFn?: SleepLike;
  now?: () => number;
}): Promise<CursorOAuthTokens> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const sleepFn = input.sleepFn ?? abortableSleep;
  const now = input.now ?? Date.now;
  let attempt = 0;
  let consecutiveErrors = 0;
  while (now() < input.expiresAtMs) {
    if (input.signal.aborted) throw abortError();
    const url = new URL(CURSOR_AUTH_POLL_PATH, CURSOR_API_ORIGIN);
    url.searchParams.set('uuid', input.uuid);
    url.searchParams.set('verifier', input.verifier);
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: input.signal,
      });
      if (response.status === 404) {
        consecutiveErrors = 0;
        await sleepFn(pollDelayMs(attempt, input.expiresAtMs - now()), input.signal);
        attempt += 1;
        continue;
      }
      if (response.status === 403) {
        const errorCode = await boundedCursorErrorCode(response);
        throw new CursorNativeAuthError(
          errorCode === 'sign_in_policy_violation'
            ? 'cursor_auth_sign_in_policy_violation'
            : 'cursor_auth_forbidden',
          false,
          `http_status=${response.status}`,
        );
      }
      if (!response.ok) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new CursorNativeAuthError(
            'cursor_auth_poll_http_failed',
            response.status >= 500 || response.status === 429,
            `http_status=${response.status}`,
          );
        }
        await sleepFn(pollDelayMs(attempt, input.expiresAtMs - now()), input.signal);
        attempt += 1;
        continue;
      }
      return await cursorTokensFromResponse(response);
    } catch (error) {
      if (error instanceof CursorNativeAuthError) throw error;
      if (input.signal.aborted) throw abortError();
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new CursorNativeAuthError('cursor_auth_poll_network_failed', true);
      }
      await sleepFn(pollDelayMs(attempt, input.expiresAtMs - now()), input.signal);
      attempt += 1;
    }
  }
  throw new CursorNativeAuthError('cursor_auth_expired', false);
}

async function cursorTokensFromResponse(response: Response): Promise<CursorOAuthTokens> {
  const text = await readBoundedResponseText(response);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CursorNativeAuthError('cursor_auth_response_invalid', false);
  }
  return {
    accessToken: requiredToken(value.accessToken, 'cursor_credential_access_token_missing'),
    refreshToken: requiredToken(value.refreshToken, 'cursor_credential_refresh_token_missing'),
  };
}

function encodeNativeCredentialBundle(
  tokens: CursorOAuthTokens,
  desktopIdentity: CursorDesktopIdentity,
  nowMs: number,
): string {
  const claims = jwtClaims(tokens.accessToken);
  const accountId = requiredString(claims.sub, 'cursor_credential_account_id_missing', 512);
  const expiresAt = typeof claims.exp === 'number' && Number.isFinite(claims.exp)
    ? Math.floor(claims.exp * 1_000)
    : undefined;
  if (!expiresAt || expiresAt <= nowMs + 60_000) {
    throw new CursorNativeAuthError('cursor_credential_access_token_expired', false);
  }
  return JSON.stringify({
    version: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
    accountId,
    authorizedClientVersion: requiredString(
      desktopIdentity.version,
      'cursor_credential_client_version_missing',
      64,
    ),
    machineId: requiredString(desktopIdentity.machineId, 'cursor_credential_machine_id_missing', 512),
    ...(desktopIdentity.macMachineId
      ? { macMachineId: requiredString(desktopIdentity.macMachineId, 'cursor_credential_mac_machine_id_invalid', 512) }
      : {}),
  });
}

export function createCursorDeviceIdentity(
  entropy: (size: number) => Buffer = randomBytes,
): CursorDesktopIdentity {
  return {
    machineId: entropy(32).toString('hex'),
    macMachineId: entropy(32).toString('hex'),
    version: CURSOR_AUTHORIZED_CLIENT_VERSION,
  };
}

function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new CursorNativeAuthError('cursor_credential_access_token_invalid', false);
  const payload = parts[1];
  if (!payload) throw new CursorNativeAuthError('cursor_credential_access_token_invalid', false);
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CursorNativeAuthError('cursor_credential_access_token_invalid', false);
  }
}

async function boundedCursorErrorCode(response: Response): Promise<string | undefined> {
  try {
    const text = await readBoundedResponseText(response);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed.error === 'string' && /^[a-z0-9_]{1,128}$/.test(parsed.error)
      ? parsed.error
      : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new CursorNativeAuthError('cursor_auth_response_too_large', false);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new CursorNativeAuthError('cursor_auth_response_too_large', false);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

class CursorNativeAuthError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly diagnostic?: string,
  ) {
    super(code);
  }
}

function failedEvent(
  message: PlatformCursorAuthStart,
  stage: CursorAuthFailureStage,
  errorCode: string,
  retryable: boolean,
  diagnostic?: string,
): ProviderCursorAuthFailed {
  return {
    type: 'provider.cursor_auth_failed',
    protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    flowId: message.flowId,
    nodeId: message.nodeId,
    stage,
    errorCode,
    retryable,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function cursorAuthErrorCode(error: unknown, flow: RunningFlow): string {
  if (flow.cancelled) return 'cursor_auth_cancelled';
  if (flow.expired) return 'cursor_auth_expired';
  if (error instanceof CursorNativeAuthError) return error.code;
  return 'cursor_auth_failed';
}

function cursorAuthRetryable(error: unknown, flow: RunningFlow): boolean {
  if (flow.cancelled || flow.expired) return false;
  return error instanceof CursorNativeAuthError ? error.retryable : false;
}

function cursorAuthDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof CursorNativeAuthError) || !error.diagnostic) return undefined;
  return safeDiagnostic(error.diagnostic);
}

function requiredToken(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new CursorNativeAuthError(code, false);
  const token = value.trim();
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES || /[\r\n\0]/.test(token)) {
    throw new CursorNativeAuthError(code, false);
  }
  return token;
}

function requiredString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new CursorNativeAuthError(code, false);
  }
  return value.trim();
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function pollDelayMs(attempt: number, remainingMs: number): number {
  return Math.max(1, Math.min(
    Math.floor(INITIAL_POLL_DELAY_MS * (1.2 ** attempt)),
    MAX_POLL_DELAY_MS,
    Math.max(1, remainingMs),
  ));
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('cursor_auth_aborted');
  error.name = 'AbortError';
  return error;
}

function assertFlowActive(flow: RunningFlow): void {
  if (flow.cancelled || flow.expired || flow.abortController.signal.aborted) throw abortError();
}

function safeDiagnostic(value: string): string | undefined {
  const result = value
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|verifier|challenge|authorization|cookie|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .trim();
  return result ? result.slice(0, MAX_DIAGNOSTIC_CHARS) : undefined;
}
