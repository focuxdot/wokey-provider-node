import { describe, expect, it, vi } from 'vitest';
import { AsyncMutex, SingleFlight } from '../src/provider-node/single-flight.js';

describe('SingleFlight', () => {
  it('coalesces concurrent calls and allows a later operation after completion', async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const firstFactory = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const coalescer = new SingleFlight<string>();

    const first = coalescer.run(firstFactory);
    const concurrent = coalescer.run(firstFactory);
    await Promise.resolve();
    expect(firstFactory).toHaveBeenCalledTimes(1);
    expect(concurrent).toBe(first);
    resolveFirst?.('shared');
    await expect(first).resolves.toBe('shared');

    const nextFactory = vi.fn(async () => 'next');
    await expect(coalescer.run(nextFactory)).resolves.toBe('next');
    expect(nextFactory).toHaveBeenCalledTimes(1);
  });

  it('clears a rejected operation so a retry can start', async () => {
    const coalescer = new SingleFlight<string>();
    await expect(
      coalescer.run(async () => {
        throw new Error('temporary failure');
      }),
    ).rejects.toThrow('temporary failure');

    await expect(coalescer.run(async () => 'retried')).resolves.toBe('retried');
  });
});

describe('AsyncMutex', () => {
  it('runs shared native-state operations in FIFO order and releases after rejection', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = mutex.run(async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = mutex.run(async () => {
      order.push('second');
      throw new Error('expected');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow('expected');
    await mutex.run(async () => { order.push('third'); });
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});
