export type ProviderRiskState = 'ready' | 'cooling_down' | 'auth_invalid';

export interface ProviderRiskSnapshot {
  state: ProviderRiskState;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  cooldownUntil?: string;
  consecutiveFailures: number;
}

export interface ProviderRiskDecision {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
}

export interface ClassifiedProviderError {
  code: string;
  message: string;
  retryAfterMs?: number;
}

const BASE_TRANSIENT_COOLDOWN_MS = 30_000;
const MAX_TRANSIENT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60_000;
const AUTH_INVALID_COOLDOWN_MS = 24 * 60 * 60_000;

export class ProviderRiskController {
  private state: ProviderRiskState = 'ready';
  private lastErrorCode: string | undefined;
  private lastErrorMessage: string | undefined;
  private cooldownUntilMs: number | undefined;
  private consecutiveFailures = 0;

  snapshot(): ProviderRiskSnapshot {
    return {
      state: this.currentState(),
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      cooldownUntil: this.cooldownUntilMs ? new Date(this.cooldownUntilMs).toISOString() : undefined,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  canDispatch(now = Date.now()): ProviderRiskDecision {
    const state = this.currentState(now);
    if (state === 'ready') return { allowed: true };

    const retryAfterMs = this.cooldownUntilMs ? Math.max(0, this.cooldownUntilMs - now) : undefined;
    return {
      allowed: false,
      errorCode: this.lastErrorCode || state,
      errorMessage: this.lastErrorMessage || 'Provider is temporarily unavailable',
      retryAfterMs,
    };
  }

  recordSuccess(): void {
    if (this.state !== 'auth_invalid') {
      this.state = 'ready';
      this.cooldownUntilMs = undefined;
    }
    this.consecutiveFailures = 0;
    this.lastErrorCode = undefined;
    this.lastErrorMessage = undefined;
  }

  recordFailure(error: unknown): ClassifiedProviderError {
    const classified = classifyProviderError(error);
    this.consecutiveFailures += 1;
    this.lastErrorCode = classified.code;
    this.lastErrorMessage = classified.message;

    if (classified.code === 'upstream_auth_invalid'
      || classified.code === 'upstream_not_configured'
      || classified.code === 'credential_refresh_invalid') {
      this.state = 'auth_invalid';
      this.cooldownUntilMs = Date.now() + AUTH_INVALID_COOLDOWN_MS;
      return classified;
    }

    this.state = 'cooling_down';
    const cooldownMs = classified.retryAfterMs ?? cooldownForError(classified.code, this.consecutiveFailures);
    this.cooldownUntilMs = Date.now() + cooldownMs;
    return {
      ...classified,
      retryAfterMs: cooldownMs,
    };
  }

  reset(): void {
    this.state = 'ready';
    this.lastErrorCode = undefined;
    this.lastErrorMessage = undefined;
    this.cooldownUntilMs = undefined;
    this.consecutiveFailures = 0;
  }

  private currentState(now = Date.now()): ProviderRiskState {
    if (this.state === 'cooling_down' && this.cooldownUntilMs && this.cooldownUntilMs <= now) {
      this.state = 'ready';
      this.cooldownUntilMs = undefined;
    }
    return this.state;
  }
}

export class UpstreamError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  if (error instanceof UpstreamError) {
    return {
      code: error.code,
      message: safeProviderErrorMessage(error.code, error.status),
      retryAfterMs: error.retryAfterMs,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('upstream_not_configured') || lower.includes('missing_refresh_token')) {
    return { code: 'upstream_not_configured', message: safeProviderErrorMessage('upstream_not_configured') };
  }
  if (
    lower.includes('invalid_grant')
    || lower.includes('refresh token not found or invalid')
    || lower.includes('refresh_token_not_found')
  ) {
    return { code: 'credential_refresh_invalid', message: safeProviderErrorMessage('credential_refresh_invalid') };
  }
  if (
    lower.includes('401')
    || lower.includes('403')
    || lower.includes('invalid token')
    || lower.includes('invalid_api_key')
    || lower.includes('unauthorized')
  ) {
    return { code: 'upstream_auth_invalid', message: safeProviderErrorMessage('upstream_auth_invalid') };
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return { code: 'upstream_rate_limited', message: safeProviderErrorMessage('upstream_rate_limited') };
  }
  if (lower.includes('quota') || lower.includes('billing') || lower.includes('insufficient_quota')) {
    return { code: 'upstream_quota_exceeded', message: safeProviderErrorMessage('upstream_quota_exceeded') };
  }
  if (lower.includes('timeout')) {
    return { code: 'upstream_timeout', message: safeProviderErrorMessage('upstream_timeout') };
  }
  return { code: 'upstream_error', message: safeProviderErrorMessage('upstream_error') };
}

export function classifyHttpUpstreamError(response: Response, body: string): UpstreamError {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  const lower = body.toLowerCase();
  if (response.status === 401 || response.status === 403) {
    return new UpstreamError('upstream_auth_invalid', safeUpstreamErrorMessage(response.status), {
      status: response.status,
    });
  }
  if (response.status === 400) {
    return new UpstreamError('upstream_request_invalid', safeUpstreamErrorMessage(response.status), {
      status: response.status,
    });
  }
  if (response.status === 429) {
    return new UpstreamError('upstream_rate_limited', safeUpstreamErrorMessage(response.status), {
      status: response.status,
      retryAfterMs,
    });
  }
  if (lower.includes('insufficient_quota') || lower.includes('quota') || lower.includes('billing')) {
    return new UpstreamError('upstream_quota_exceeded', safeUpstreamErrorMessage(response.status), {
      status: response.status,
    });
  }
  if (response.status >= 500) {
    return new UpstreamError('upstream_server_error', safeUpstreamErrorMessage(response.status), {
      status: response.status,
      retryAfterMs,
    });
  }
  return new UpstreamError('upstream_error', safeUpstreamErrorMessage(response.status), {
    status: response.status,
    retryAfterMs,
  });
}

export function cooldownForError(errorCode: string, consecutiveFailures: number): number {
  if (errorCode === 'upstream_rate_limited') return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  if (errorCode === 'upstream_quota_exceeded') return DEFAULT_QUOTA_COOLDOWN_MS;
  if (errorCode === 'upstream_auth_invalid' || errorCode === 'upstream_not_configured' || errorCode === 'credential_refresh_invalid') return AUTH_INVALID_COOLDOWN_MS;
  const exponent = Math.max(0, Math.min(6, consecutiveFailures - 1));
  return Math.min(MAX_TRANSIENT_COOLDOWN_MS, BASE_TRANSIENT_COOLDOWN_MS * (2 ** exponent));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function safeUpstreamErrorMessage(status: number): string {
  return `upstream_${status}`;
}

function safeProviderErrorMessage(code: string, status?: number): string {
  return status ? `upstream_${status}` : code;
}
