export type WebSocketSendLane = 'control' | 'window' | 'interactive' | 'bulk';

export interface SchedulableWebSocket {
  readyState?: number;
  bufferedAmount?: number;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  terminate?(): void;
  close?(): void;
}

export interface WebSocketSendSchedulerOptions {
  highWaterBytes: number;
  lowWaterBytes?: number;
  maxQueuedBytes: number;
  controlReserveBytes?: number;
  interactiveReserveBytes?: number;
  sendTimeoutMs: number;
  fallbackPollInitialMs?: number;
  fallbackPollMaxMs?: number;
  maxFramesPerPump?: number;
}

export interface WebSocketSendRequest {
  lane: WebSocketSendLane;
  sessionId?: string;
  callback?: (error?: Error | null) => void;
}

export interface WebSocketSendEnqueueResult {
  accepted: boolean;
  backpressured: boolean;
  queuedBytes: number;
  bufferedBytes: number;
  error?: Error;
}

export interface WebSocketSendSchedulerSnapshot {
  queuedBytes: number;
  inFlight: number;
  peakBufferedBytes: number;
  backpressureCount: number;
  rejectedFrames: number;
}

interface ScheduledFrame {
  data: string | Buffer;
  bytes: number;
  lane: WebSocketSendLane;
  sessionKey: string;
  deadlineAt: number;
  callback?: (error?: Error | null) => void;
  completed: boolean;
}

class SessionRoundRobinQueue {
  private readonly queues = new Map<string, ScheduledFrame[]>();
  private readonly order: string[] = [];

  get size(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.length;
    return count;
  }

  enqueue(frame: ScheduledFrame): void {
    const queue = this.queues.get(frame.sessionKey);
    if (queue) {
      queue.push(frame);
      return;
    }
    this.queues.set(frame.sessionKey, [frame]);
    this.order.push(frame.sessionKey);
  }

  shift(): ScheduledFrame | undefined {
    const sessionKey = this.order.shift();
    if (!sessionKey) return undefined;
    const queue = this.queues.get(sessionKey);
    const frame = queue?.shift();
    if (!queue || queue.length === 0) {
      this.queues.delete(sessionKey);
    } else {
      this.order.push(sessionKey);
    }
    return frame;
  }

  drain(): ScheduledFrame[] {
    const frames: ScheduledFrame[] = [];
    while (this.order.length > 0) {
      const frame = this.shift();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  earliestDeadline(): number | undefined {
    let earliest: number | undefined;
    for (const queue of this.queues.values()) {
      for (const frame of queue) {
        if (earliest === undefined || frame.deadlineAt < earliest) earliest = frame.deadlineAt;
      }
    }
    return earliest;
  }
}

/**
 * One scheduler owns all writes for one physical WebSocket. It replaces the
 * previous per-session bufferedAmount poll loops with callback-driven writes,
 * strict control/window priority, and weighted fair data scheduling. The real
 * `ws` transport reports completion after a frame is written, so one in-flight
 * frame is enough to provide backpressure without polling. Callback-less test
 * or compatibility transports use a bounded exponential fallback only while
 * their reported buffer remains above the high-water mark.
 */
export class WebSocketSendScheduler {
  private readonly queues: Record<WebSocketSendLane, SessionRoundRobinQueue> = {
    control: new SessionRoundRobinQueue(),
    window: new SessionRoundRobinQueue(),
    interactive: new SessionRoundRobinQueue(),
    bulk: new SessionRoundRobinQueue(),
  };
  private readonly inFlight = new Set<ScheduledFrame>();
  private lowWaterBytes: number;
  private controlReserveBytes: number;
  private interactiveReserveBytes: number;
  private readonly fallbackPollInitialMs: number;
  private readonly fallbackPollMaxMs: number;
  private readonly maxFramesPerPump: number;
  private highWaterBytes: number;
  private readonly sendTimeoutMs: number;
  private readonly supportsSendCallback: boolean;
  private maxQueuedBytes: number;
  private queuedBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private closed = false;
  private dataLaneCursor = 0;
  private peakBufferedBytes = 0;
  private backpressureCount = 0;
  private rejectedFrames = 0;
  private pressureBlocked = false;
  private fallbackPollDelayMs: number;

  constructor(
    private readonly socket: SchedulableWebSocket,
    options: WebSocketSendSchedulerOptions,
  ) {
    this.maxQueuedBytes = positiveInteger(options.maxQueuedBytes, 1);
    this.highWaterBytes = nonNegativeInteger(options.highWaterBytes, 0);
    this.sendTimeoutMs = positiveInteger(options.sendTimeoutMs, 1);
    const defaultLowWaterBytes = Math.floor(this.highWaterBytes / 2);
    this.lowWaterBytes = Math.min(
      this.highWaterBytes,
      nonNegativeInteger(options.lowWaterBytes ?? defaultLowWaterBytes, defaultLowWaterBytes),
    );
    this.controlReserveBytes = Math.max(0, Math.floor(options.controlReserveBytes ?? 256 * 1024));
    this.interactiveReserveBytes = Math.max(
      0,
      Math.floor(
        options.interactiveReserveBytes
          ?? Math.min(1024 * 1024, Math.floor(this.maxQueuedBytes / 4)),
      ),
    );
    this.fallbackPollInitialMs = Math.max(1, Math.floor(options.fallbackPollInitialMs ?? 25));
    this.fallbackPollMaxMs = Math.max(
      this.fallbackPollInitialMs,
      Math.floor(options.fallbackPollMaxMs ?? 250),
    );
    this.fallbackPollDelayMs = this.fallbackPollInitialMs;
    this.maxFramesPerPump = Math.max(1, Math.floor(options.maxFramesPerPump ?? 64));
    this.supportsSendCallback = this.socket.send.length >= 2;
  }

  enqueue(data: string | Buffer, request: WebSocketSendRequest): WebSocketSendEnqueueResult {
    const bufferedBytes = this.bufferedAmount();
    const bytes = wireBytes(data);
    const backpressured = this.pressureBlocked
      || bufferedBytes > this.highWaterBytes
      || this.queuedBytes > 0;
    if (this.closed || !this.socketOpen()) {
      const error = schedulerError('provider_websocket_disconnected');
      request.callback?.(error);
      return this.rejectedResult(error, backpressured, bufferedBytes);
    }

    const admissionLimit = request.lane === 'control' || request.lane === 'window'
      ? this.maxQueuedBytes + this.controlReserveBytes
      : request.lane === 'bulk'
        ? Math.max(0, this.maxQueuedBytes - this.interactiveReserveBytes)
        : this.maxQueuedBytes;
    if (bufferedBytes + this.queuedBytes + bytes > admissionLimit) {
      const error = schedulerError('provider_websocket_queue_overflow');
      this.rejectedFrames += 1;
      request.callback?.(error);
      return this.rejectedResult(error, true, bufferedBytes);
    }

    const frame: ScheduledFrame = {
      data,
      bytes,
      lane: request.lane,
      sessionKey: request.sessionId ?? `__${request.lane}__`,
      deadlineAt: Date.now() + this.sendTimeoutMs,
      callback: request.callback,
      completed: false,
    };
    this.queues[request.lane].enqueue(frame);
    this.queuedBytes += bytes;
    this.pump();
    const currentBufferedBytes = this.bufferedAmount();
    return {
      accepted: true,
      backpressured: backpressured || this.pressureBlocked,
      queuedBytes: this.queuedBytes,
      bufferedBytes: Math.max(bufferedBytes, currentBufferedBytes),
    };
  }

  setMaxQueuedBytes(value: number): void {
    this.setQueueLimits({ maxQueuedBytes: value });
  }

  setHighWaterBytes(value: number): void {
    this.setQueueLimits({ highWaterBytes: value });
  }

  setQueueLimits(options: {
    maxQueuedBytes?: number;
    highWaterBytes?: number;
    lowWaterBytes?: number;
    controlReserveBytes?: number;
    interactiveReserveBytes?: number;
  }): void {
    const maxChanged = Number.isFinite(options.maxQueuedBytes) && Number(options.maxQueuedBytes) > 0;
    if (maxChanged) this.maxQueuedBytes = Math.floor(Number(options.maxQueuedBytes));
    if (Number.isFinite(options.highWaterBytes) && Number(options.highWaterBytes) >= 0) {
      this.highWaterBytes = Math.min(this.maxQueuedBytes, Math.floor(Number(options.highWaterBytes)));
    }
    const defaultLowWaterBytes = Math.floor(this.highWaterBytes / 2);
    this.lowWaterBytes = Math.min(
      this.highWaterBytes,
      Number.isFinite(options.lowWaterBytes) && Number(options.lowWaterBytes) >= 0
        ? Math.floor(Number(options.lowWaterBytes))
        : defaultLowWaterBytes,
    );
    if (maxChanged || options.controlReserveBytes !== undefined) {
      const requested = options.controlReserveBytes ?? Math.min(256 * 1024, this.maxQueuedBytes);
      this.controlReserveBytes = Math.min(
        this.maxQueuedBytes,
        Math.max(0, Math.floor(Number(requested) || 0)),
      );
    }
    if (maxChanged || options.interactiveReserveBytes !== undefined) {
      const requested = options.interactiveReserveBytes
        ?? Math.min(1024 * 1024, Math.floor(this.maxQueuedBytes / 4));
      this.interactiveReserveBytes = Math.min(
        this.maxQueuedBytes,
        Math.max(0, Math.floor(Number(requested) || 0)),
      );
    }
  }

  close(error = schedulerError('provider_websocket_disconnected')): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const queue of Object.values(this.queues)) {
      for (const frame of queue.drain()) this.finish(frame, error);
    }
    this.queuedBytes = 0;
    for (const frame of [...this.inFlight]) this.finish(frame, error);
  }

  snapshot(): WebSocketSendSchedulerSnapshot {
    return {
      queuedBytes: this.queuedBytes,
      inFlight: this.inFlight.size,
      peakBufferedBytes: this.peakBufferedBytes,
      backpressureCount: this.backpressureCount,
      rejectedFrames: this.rejectedFrames,
    };
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.expireFrames();
      if (!this.socketOpen()) {
        this.close(schedulerError('provider_websocket_disconnected'));
        return;
      }
      if (this.inFlight.size > 0) {
        this.scheduleDeadlineTimer();
        return;
      }
      let bufferedBytes = this.bufferedAmount();
      this.observePressure(bufferedBytes);
      if (!this.supportsSendCallback && this.pressureBlocked) {
        this.schedulePressureFallback();
        return;
      }

      let sent = 0;
      while (sent < this.maxFramesPerPump) {
        if (this.inFlight.size > 0) break;
        const frame = this.nextFrame();
        if (!frame) break;
        this.queuedBytes = Math.max(0, this.queuedBytes - frame.bytes);
        if (frame.deadlineAt <= Date.now()) {
          this.finish(frame, schedulerError('provider_websocket_send_timeout'));
          continue;
        }
        this.dispatch(frame);
        sent += 1;
        bufferedBytes = this.bufferedAmount();
        this.observePressure(bufferedBytes);
        if (!this.supportsSendCallback && this.pressureBlocked) break;
      }
    } finally {
      this.pumping = false;
    }

    if (this.closed) return;
    if (this.inFlight.size > 0) {
      this.scheduleDeadlineTimer();
      return;
    }
    if (this.hasQueuedFrames()) {
      if (!this.supportsSendCallback && this.pressureBlocked) {
        this.schedulePressureFallback();
      } else {
        this.scheduleTimer(0);
      }
    } else {
      this.scheduleDeadlineTimer();
    }
  }

  private dispatch(frame: ScheduledFrame): void {
    try {
      if (this.socket.send.length < 2) {
        this.socket.send(frame.data);
        this.finish(frame);
        return;
      }
      this.inFlight.add(frame);
      this.socket.send(frame.data, (error?: Error) => {
        this.finish(frame, error);
        this.pump();
      });
    } catch (error) {
      this.finish(frame, error instanceof Error ? error : schedulerError('provider_websocket_send_failed'));
    }
  }

  private finish(frame: ScheduledFrame, error?: Error | null): void {
    if (frame.completed) return;
    frame.completed = true;
    this.inFlight.delete(frame);
    frame.callback?.(error);
  }

  private expireFrames(): void {
    const now = Date.now();
    if ([...this.inFlight].some((frame) => frame.deadlineAt <= now)) {
      const error = schedulerError('provider_websocket_send_timeout');
      try {
        this.close(error);
      } finally {
        try {
          if (this.socket.terminate) this.socket.terminate();
          else this.socket.close?.();
        } catch {
          // The scheduler is already closed and all callers have been failed.
        }
      }
      return;
    }
    for (const lane of Object.keys(this.queues) as WebSocketSendLane[]) {
      const queue = this.queues[lane];
      const retained: ScheduledFrame[] = [];
      for (const frame of queue.drain()) {
        if (frame.deadlineAt <= now) {
          this.queuedBytes = Math.max(0, this.queuedBytes - frame.bytes);
          this.finish(frame, schedulerError('provider_websocket_send_timeout'));
        } else {
          retained.push(frame);
        }
      }
      for (const frame of retained) queue.enqueue(frame);
    }
  }

  private nextFrame(): ScheduledFrame | undefined {
    const control = this.queues.control.shift();
    if (control) return control;
    const window = this.queues.window.shift();
    if (window) return window;

    // Interactive receives four turns for every bulk turn on the shared
    // connection. Per-lane queues are independently round-robin by session.
    const dataLanes: WebSocketSendLane[] = [
      'interactive',
      'interactive',
      'interactive',
      'interactive',
      'bulk',
    ];
    for (let checked = 0; checked < dataLanes.length; checked += 1) {
      const index = (this.dataLaneCursor + checked) % dataLanes.length;
      const lane = dataLanes[index];
      if (!lane) continue;
      const frame = this.queues[lane].shift();
      if (frame) {
        this.dataLaneCursor = (index + 1) % dataLanes.length;
        return frame;
      }
    }
    return undefined;
  }

  private hasQueuedFrames(): boolean {
    return Object.values(this.queues).some((queue) => queue.size > 0);
  }

  private observePressure(bufferedBytes: number): void {
    if (bufferedBytes > this.highWaterBytes) {
      if (!this.pressureBlocked) {
        this.pressureBlocked = true;
        this.backpressureCount += 1;
      }
      return;
    }
    if (bufferedBytes <= this.lowWaterBytes) {
      this.pressureBlocked = false;
      this.fallbackPollDelayMs = this.fallbackPollInitialMs;
    }
  }

  private schedulePressureFallback(): void {
    this.scheduleTimer(this.fallbackPollDelayMs);
    this.fallbackPollDelayMs = Math.min(
      this.fallbackPollMaxMs,
      this.fallbackPollDelayMs * 2,
    );
  }

  private scheduleDeadlineTimer(): void {
    let earliest: number | undefined;
    for (const frame of this.inFlight) {
      if (earliest === undefined || frame.deadlineAt < earliest) earliest = frame.deadlineAt;
    }
    for (const queue of Object.values(this.queues)) {
      const deadline = queue.earliestDeadline();
      if (deadline !== undefined && (earliest === undefined || deadline < earliest)) earliest = deadline;
    }
    if (earliest !== undefined) this.scheduleTimer(Math.max(1, earliest - Date.now()));
  }

  private scheduleTimer(delayMs: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private socketOpen(): boolean {
    return this.socket.readyState === undefined || this.socket.readyState === 1;
  }

  private bufferedAmount(): number {
    const value = Number(this.socket.bufferedAmount ?? 0);
    const bufferedBytes = Number.isFinite(value) ? Math.max(0, value) : 0;
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, bufferedBytes);
    return bufferedBytes;
  }

  private rejectedResult(
    error: Error,
    backpressured: boolean,
    bufferedBytes: number,
  ): WebSocketSendEnqueueResult {
    return {
      accepted: false,
      backpressured,
      queuedBytes: this.queuedBytes,
      bufferedBytes,
      error,
    };
  }
}

function wireBytes(data: string | Buffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

function schedulerError(code: string): Error {
  const error = new Error(code);
  error.name = 'WebSocketSendSchedulerError';
  return error;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
