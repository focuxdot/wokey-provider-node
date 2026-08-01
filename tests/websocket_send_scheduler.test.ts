import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketSendScheduler } from '../src/shared/websocket-send-scheduler.js';

afterEach(() => vi.useRealTimers());

describe('WebSocketSendScheduler', () => {
  it('uses one connection watcher and prioritizes control/window over interactive/bulk', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 128,
      send(data: string | Buffer) {
        sent.push(data.toString());
      },
    };
    const scheduler = new WebSocketSendScheduler(socket, {
      highWaterBytes: 64,
      maxQueuedBytes: 1024,
      sendTimeoutMs: 1_000,
      fallbackPollInitialMs: 5,
      fallbackPollMaxMs: 5,
    });

    scheduler.enqueue('bulk', { lane: 'bulk', sessionId: 'bulk-1' });
    scheduler.enqueue('interactive', { lane: 'interactive', sessionId: 'chat-1' });
    scheduler.enqueue('window', { lane: 'window', sessionId: 'chat-1' });
    scheduler.enqueue('control', { lane: 'control' });

    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);

    expect(sent).toEqual(['control', 'window', 'interactive', 'bulk']);
    expect(scheduler.snapshot().backpressureCount).toBe(1);
  });

  it('terminates the connection instead of sending again after an in-flight timeout', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const errors: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send(data: string | Buffer, _callback?: (error?: Error) => void) {
        sent.push(data.toString());
      },
      terminate: vi.fn(),
    };
    const scheduler = new WebSocketSendScheduler(socket, {
      highWaterBytes: 1024,
      maxQueuedBytes: 1024,
      sendTimeoutMs: 20,
    });

    scheduler.enqueue('first', {
      lane: 'interactive',
      callback: (error) => errors.push(error?.message ?? 'ok'),
    });
    await vi.advanceTimersByTimeAsync(10);
    scheduler.enqueue('later-control', {
      lane: 'control',
      callback: (error) => errors.push(error?.message ?? 'ok'),
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(sent).toEqual(['first']);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      'provider_websocket_send_timeout',
      'provider_websocket_send_timeout',
    ]);
    expect(scheduler.snapshot()).toMatchObject({ queuedBytes: 0, inFlight: 0 });
    expect(scheduler.enqueue('after-timeout', { lane: 'control' })).toMatchObject({
      accepted: false,
      error: expect.objectContaining({ message: 'provider_websocket_disconnected' }),
    });
  });

  it('round-robins sessions and rejects data beyond the connection budget', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 1,
      send(data: string | Buffer) {
        sent.push(data.toString());
      },
    };
    const scheduler = new WebSocketSendScheduler(socket, {
      highWaterBytes: 0,
      maxQueuedBytes: 12,
      controlReserveBytes: 0,
      sendTimeoutMs: 1_000,
      fallbackPollInitialMs: 5,
      fallbackPollMaxMs: 5,
    });

    expect(scheduler.enqueue('a1', { lane: 'bulk', sessionId: 'a' }).accepted).toBe(true);
    expect(scheduler.enqueue('a2', { lane: 'bulk', sessionId: 'a' }).accepted).toBe(true);
    expect(scheduler.enqueue('b1', { lane: 'bulk', sessionId: 'b' }).accepted).toBe(true);
    const rejected = scheduler.enqueue('0123456789', { lane: 'bulk', sessionId: 'c' });
    expect(rejected).toMatchObject({ accepted: false, backpressured: true });
    expect(rejected.error?.message).toBe('provider_websocket_queue_overflow');

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);
    expect(sent).toEqual(['a1', 'b1', 'a2']);
  });

  it('reserves queue capacity for interactive and control traffic ahead of bulk', () => {
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send(_data: string | Buffer, _callback?: (error?: Error) => void) {},
    };
    const scheduler = new WebSocketSendScheduler(socket, {
      highWaterBytes: 1024,
      maxQueuedBytes: 20,
      controlReserveBytes: 4,
      interactiveReserveBytes: 6,
      sendTimeoutMs: 1_000,
    });

    expect(scheduler.enqueue('x', { lane: 'bulk', sessionId: 'in-flight' }).accepted).toBe(true);
    expect(scheduler.enqueue('b'.repeat(14), { lane: 'bulk', sessionId: 'bulk' }).accepted).toBe(true);
    expect(scheduler.enqueue('b', { lane: 'bulk', sessionId: 'bulk' }).accepted).toBe(false);
    expect(scheduler.enqueue('i'.repeat(6), { lane: 'interactive', sessionId: 'chat' }).accepted).toBe(true);
    expect(scheduler.enqueue('c'.repeat(4), { lane: 'control' }).accepted).toBe(true);

    scheduler.close();
  });
});
