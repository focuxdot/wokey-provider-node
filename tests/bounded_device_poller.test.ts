import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedDevicePoller } from '../src/provider-node/bounded-device-poller.js';

describe('BoundedDevicePoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps only one active flow and never polls faster than the minimum interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const firstPoll = vi.fn(async () => ({ status: 'pending' as const }));
    const secondPoll = vi.fn(async () => ({ status: 'pending' as const }));
    const poller = new BoundedDevicePoller<string>();
    const common = {
      vendorIntervalMs: 1_000,
      vendorExpiresAt: Date.now() + 30 * 60_000,
      classifyError: () => ({ code: 'failed', message: 'failed', retryable: false }),
    };

    poller.start({ id: 'first', poll: firstPoll, ...common });
    poller.start({ id: 'second', poll: secondPoll, ...common });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(firstPoll).not.toHaveBeenCalled();
    expect(secondPoll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(firstPoll).not.toHaveBeenCalled();
    expect(secondPoll).toHaveBeenCalledTimes(1);
    expect(poller.get('first')).toBeUndefined();
    poller.close();
  });

  it('slows pending polling after two and five minutes and stops at fifteen minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const poll = vi.fn(async () => ({ status: 'pending' as const }));
    const poller = new BoundedDevicePoller<string>();
    poller.start({
      id: 'flow',
      vendorIntervalMs: 5_000,
      vendorExpiresAt: Date.now() + 30 * 60_000,
      poll,
      classifyError: () => ({ code: 'failed', message: 'failed', retryable: false }),
    });

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    let state = poller.get('flow');
    expect(state?.nextPollAt && state.nextPollAt - Date.now()).toBe(10_000);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    state = poller.get('flow');
    expect(state?.nextPollAt && state.nextPollAt - Date.now()).toBe(20_000);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    state = poller.get('flow');
    expect(state?.status).toBe('expired');
    expect(poll.mock.calls.length).toBeLessThanOrEqual(72);
    poller.close();
  });

  it('backs off retryable failures and stops after five consecutive errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const poll = vi.fn(async () => {
      throw new Error('network');
    });
    const poller = new BoundedDevicePoller<string>();
    poller.start({
      id: 'flow',
      vendorIntervalMs: 5_000,
      vendorExpiresAt: Date.now() + 30 * 60_000,
      poll,
      classifyError: () => ({ code: 'oauth_network_error', message: 'network', retryable: true }),
    });

    await vi.advanceTimersByTimeAsync(80_000);
    const state = poller.get('flow');
    expect(poll).toHaveBeenCalledTimes(5);
    expect(state).toMatchObject({
      status: 'failed',
      error: { code: 'oauth_network_error', retryable: true },
    });
    poller.close();
  });

  it('honors an upstream slow-down instruction for all later polls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' as const, intervalIncreaseMs: 5_000 })
      .mockResolvedValue({ status: 'pending' as const });
    const poller = new BoundedDevicePoller<string>();
    poller.start({
      id: 'flow',
      vendorIntervalMs: 5_000,
      vendorExpiresAt: Date.now() + 30 * 60_000,
      poll,
      classifyError: () => ({ code: 'failed', message: 'failed', retryable: false }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const state = poller.get('flow');
    expect(poll).toHaveBeenCalledTimes(1);
    expect(state?.nextPollAt && state.nextPollAt - Date.now()).toBe(10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.close();
  });

  it('aborts an in-flight request at the hard deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    let requestSignal: AbortSignal | undefined;
    const poll = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ status: 'pending' }>((_resolve, reject) => {
          requestSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const poller = new BoundedDevicePoller<string>({ maxLifetimeMs: 10_000 });
    poller.start({
      id: 'flow',
      vendorIntervalMs: 5_000,
      vendorExpiresAt: Date.now() + 30 * 60_000,
      poll,
      classifyError: () => ({ code: 'failed', message: 'failed', retryable: true }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestSignal?.aborted).toBe(true);
    expect(poller.get('flow')?.status).toBe('expired');
    poller.close();
  });
});
