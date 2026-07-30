export interface ProviderNodeErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
}

export interface ProviderNodeErrorPayload {
  ok: false;
  error: string;
  message: string;
  retryable: boolean;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class ProviderNodeError extends Error {
  readonly errorCode: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly upstreamStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(errorCode: string, message: string, options: ProviderNodeErrorOptions = {}) {
    super(message);
    this.name = 'ProviderNodeError';
    this.errorCode = errorCode;
    this.statusCode = options.statusCode ?? 400;
    this.retryable = options.retryable ?? false;
    this.upstreamStatus = options.upstreamStatus;
    this.details = options.details;
  }
}

export function providerNodeErrorPayload(
  error: ProviderNodeError,
  requestId?: string,
): ProviderNodeErrorPayload {
  return {
    ok: false,
    error: error.errorCode,
    message: error.message,
    retryable: error.retryable,
    upstreamStatus: error.upstreamStatus,
    details: error.details,
    requestId,
  };
}

export function networkProviderNodeError(
  scope: 'oauth' | 'platform',
  error: unknown,
): ProviderNodeError {
  const causeCode = nestedCauseCode(error);
  const details = causeCode ? { causeCode } : undefined;

  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return new ProviderNodeError(
      `${scope}_dns_failed`,
      scope === 'oauth'
        ? 'Could not resolve the authorization service hostname.'
        : 'Could not resolve the Platform hostname.',
      { statusCode: 502, retryable: true, details },
    );
  }
  if (causeCode && /(TIMEOUT|TIMEDOUT)/i.test(causeCode)) {
    return new ProviderNodeError(
      `${scope}_connect_timeout`,
      scope === 'oauth'
        ? 'Timed out while connecting to the authorization service.'
        : 'Timed out while connecting to Platform.',
      { statusCode: 504, retryable: true, details },
    );
  }
  if (causeCode && /(CERT|TLS|SSL)/i.test(causeCode)) {
    return new ProviderNodeError(
      `${scope}_tls_failed`,
      scope === 'oauth'
        ? 'Could not establish a secure connection to the authorization service.'
        : 'Could not establish a secure connection to Platform.',
      { statusCode: 502, retryable: true, details },
    );
  }
  return new ProviderNodeError(
    `${scope}_network_error`,
    scope === 'oauth'
      ? 'Could not connect to the authorization service.'
      : 'Could not connect to Platform.',
    { statusCode: 502, retryable: true, details },
  );
}

function nestedCauseCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && record.code) return record.code;
    current = record.cause;
  }
  return undefined;
}
