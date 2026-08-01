export type DevicePollOutcome<T> =
  | { status: 'pending'; intervalIncreaseMs?: number }
  | { status: 'succeeded'; value: T };

export interface DevicePollFailure {
  code: string;
  message: string;
  retryable: boolean;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface DevicePollSnapshot<T> {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  startedAt: number;
  expiresAt: number;
  nextPollAt?: number;
  pollCount: number;
  value?: T;
  error?: DevicePollFailure;
}

interface DevicePollAttempt<T> extends DevicePollSnapshot<T> {
  baseIntervalMs: number;
  consecutiveErrors: number;
  poll: (signal: AbortSignal) => Promise<DevicePollOutcome<T>>;
  classifyError: (error: unknown) => DevicePollFailure;
  timer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  inFlight: boolean;
}

export interface BoundedDevicePollerOptions {
  minimumIntervalMs?: number;
  maxLifetimeMs?: number;
  maxConsecutiveErrors?: number;
  terminalRetentionMs?: number;
}

export interface StartDevicePollOptions<T> {
  id: string;
  vendorIntervalMs: number;
  vendorExpiresAt: number;
  poll: (signal: AbortSignal) => Promise<DevicePollOutcome<T>>;
  classifyError: (error: unknown) => DevicePollFailure;
}

const DEFAULT_MINIMUM_INTERVAL_MS = 5_000;
const DEFAULT_MAX_LIFETIME_MS = 15 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;
const MID_STAGE_AFTER_MS = 2 * 60_000;
const LATE_STAGE_AFTER_MS = 5 * 60_000;
const MID_STAGE_MINIMUM_INTERVAL_MS = 10_000;
const LATE_STAGE_MINIMUM_INTERVAL_MS = 20_000;
const MAX_TRANSIENT_BACKOFF_MS = 60_000;

/**
 * Runs at most one device-code flow at a time. Pending polls slow down as the
 * flow ages, transient failures back off, and every task has a hard deadline.
 */
export class BoundedDevicePoller<T> {
  private readonly minimumIntervalMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxConsecutiveErrors: number;
  private readonly terminalRetentionMs: number;
  private attempt?: DevicePollAttempt<T>;

  constructor(options: BoundedDevicePollerOptions = {}) {
    this.minimumIntervalMs = positiveNumber(options.minimumIntervalMs, DEFAULT_MINIMUM_INTERVAL_MS);
    this.maxLifetimeMs = positiveNumber(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS);
    this.maxConsecutiveErrors = positiveInteger(options.maxConsecutiveErrors, DEFAULT_MAX_CONSECUTIVE_ERRORS);
    this.terminalRetentionMs = positiveNumber(options.terminalRetentionMs, DEFAULT_TERMINAL_RETENTION_MS);
  }

  start(options: StartDevicePollOptions<T>): DevicePollSnapshot<T> {
    this.clearAttempt();
    const now = Date.now();
    const vendorExpiresAt = Number.isFinite(options.vendorExpiresAt)
      ? options.vendorExpiresAt
      : now + this.maxLifetimeMs;
    const attempt: DevicePollAttempt<T> = {
      id: options.id,
      status: 'pending',
      startedAt: now,
      expiresAt: Math.min(vendorExpiresAt, now + this.maxLifetimeMs),
      pollCount: 0,
      baseIntervalMs: Math.max(
        this.minimumIntervalMs,
        positiveNumber(options.vendorIntervalMs, this.minimumIntervalMs),
      ),
      consecutiveErrors: 0,
      poll: options.poll,
      classifyError: options.classifyError,
      inFlight: false,
    };
    this.attempt = attempt;
    if (attempt.expiresAt <= now) this.finish(attempt, 'expired');
    else {
      attempt.deadlineTimer = setTimeout(() => this.finish(attempt, 'expired'), attempt.expiresAt - now);
      this.schedule(attempt, this.pendingDelay(attempt, now));
    }
    return snapshot(attempt);
  }

  get(id: string): DevicePollSnapshot<T> | undefined {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== id) return undefined;
    if (attempt.status === 'pending' && attempt.expiresAt <= Date.now()) {
      this.finish(attempt, 'expired');
    }
    return snapshot(attempt);
  }

  current(): DevicePollSnapshot<T> | undefined {
    const attempt = this.attempt;
    return attempt ? this.get(attempt.id) : undefined;
  }

  close(): void {
    this.clearAttempt();
  }

  private pendingDelay(attempt: DevicePollAttempt<T>, now = Date.now()): number {
    const elapsedMs = Math.max(0, now - attempt.startedAt);
    if (elapsedMs >= LATE_STAGE_AFTER_MS) {
      return Math.max(attempt.baseIntervalMs, LATE_STAGE_MINIMUM_INTERVAL_MS);
    }
    if (elapsedMs >= MID_STAGE_AFTER_MS) {
      return Math.max(attempt.baseIntervalMs, MID_STAGE_MINIMUM_INTERVAL_MS);
    }
    return attempt.baseIntervalMs;
  }

  private transientDelay(attempt: DevicePollAttempt<T>): number {
    const exponentialMs = attempt.baseIntervalMs * 2 ** Math.max(0, attempt.consecutiveErrors - 1);
    return Math.max(this.pendingDelay(attempt), Math.min(MAX_TRANSIENT_BACKOFF_MS, exponentialMs));
  }

  private schedule(attempt: DevicePollAttempt<T>, requestedDelayMs: number): void {
    if (this.attempt !== attempt || attempt.status !== 'pending') return;
    if (attempt.timer) clearTimeout(attempt.timer);
    const now = Date.now();
    const remainingMs = attempt.expiresAt - now;
    if (remainingMs <= 0) {
      this.finish(attempt, 'expired');
      return;
    }
    const delayMs = Math.max(0, Math.min(requestedDelayMs, remainingMs));
    attempt.nextPollAt = now + delayMs;
    attempt.timer = setTimeout(() => {
      attempt.timer = undefined;
      void this.run(attempt);
    }, delayMs);
  }

  private async run(attempt: DevicePollAttempt<T>): Promise<void> {
    if (this.attempt !== attempt || attempt.status !== 'pending' || attempt.inFlight) return;
    if (attempt.expiresAt <= Date.now()) {
      this.finish(attempt, 'expired');
      return;
    }
    attempt.inFlight = true;
    attempt.nextPollAt = undefined;
    attempt.pollCount += 1;
    const abortController = new AbortController();
    attempt.abortController = abortController;
    try {
      const outcome = await attempt.poll(abortController.signal);
      if (this.attempt !== attempt || attempt.status !== 'pending') return;
      attempt.consecutiveErrors = 0;
      if (outcome.status === 'succeeded') {
        attempt.value = outcome.value;
        this.finish(attempt, 'succeeded');
        return;
      }
      if (
        typeof outcome.intervalIncreaseMs === 'number' &&
        Number.isFinite(outcome.intervalIncreaseMs) &&
        outcome.intervalIncreaseMs > 0
      ) {
        attempt.baseIntervalMs += outcome.intervalIncreaseMs;
      }
      this.schedule(attempt, this.pendingDelay(attempt));
    } catch (error) {
      if (this.attempt !== attempt || attempt.status !== 'pending') return;
      const failure = attempt.classifyError(error);
      attempt.consecutiveErrors += 1;
      if (!failure.retryable || attempt.consecutiveErrors >= this.maxConsecutiveErrors) {
        attempt.error = failure;
        this.finish(attempt, 'failed');
        return;
      }
      this.schedule(attempt, this.transientDelay(attempt));
    } finally {
      if (attempt.abortController === abortController) attempt.abortController = undefined;
      attempt.inFlight = false;
    }
  }

  private finish(attempt: DevicePollAttempt<T>, status: 'succeeded' | 'failed' | 'expired'): void {
    if (this.attempt !== attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.deadlineTimer) clearTimeout(attempt.deadlineTimer);
    attempt.abortController?.abort();
    attempt.timer = undefined;
    attempt.deadlineTimer = undefined;
    attempt.abortController = undefined;
    attempt.nextPollAt = undefined;
    attempt.status = status;
    attempt.cleanupTimer = setTimeout(() => {
      if (this.attempt === attempt) this.attempt = undefined;
    }, this.terminalRetentionMs);
  }

  private clearAttempt(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.deadlineTimer) clearTimeout(attempt.deadlineTimer);
    if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer);
    attempt.abortController?.abort();
    this.attempt = undefined;
  }
}

function snapshot<T>(attempt: DevicePollAttempt<T>): DevicePollSnapshot<T> {
  return {
    id: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    nextPollAt: attempt.nextPollAt,
    pollCount: attempt.pollCount,
    value: attempt.value,
    error: attempt.error,
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = positiveNumber(value, fallback);
  return Math.max(1, Math.floor(parsed));
}
