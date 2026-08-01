/** Coalesces concurrent calls so only one asynchronous operation runs at a time. */
export class SingleFlight<T> {
  private inFlight?: Promise<T>;

  run(factory: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight;
    const operation = Promise.resolve().then(factory);
    this.inFlight = operation;
    operation.then(
      () => this.clear(operation),
      () => this.clear(operation),
    );
    return operation;
  }

  private clear(operation: Promise<T>): void {
    if (this.inFlight === operation) this.inFlight = undefined;
  }
}

/** FIFO mutual exclusion for operations that temporarily replace shared native state. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(factory: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await factory();
    } finally {
      release();
    }
  }
}
