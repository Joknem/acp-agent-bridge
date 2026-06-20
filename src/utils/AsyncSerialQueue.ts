export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = false;
  private queued = 0;

  run<T>(work: () => Promise<T>): Promise<T> {
    this.queued += 1;

    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.queued = Math.max(0, this.queued - 1);
        this.active = true;
        try {
          return await work();
        } finally {
          this.active = false;
        }
      });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  status() {
    return {
      active: this.active,
      queued: this.queued,
    };
  }
}
