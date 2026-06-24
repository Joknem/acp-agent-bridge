export class ConversationQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  enqueue(work: () => Promise<void>) {
    this.queued += 1;
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.queued = Math.max(0, this.queued - 1);
        await work();
      });
    return this.tail;
  }

  status() {
    return {
      queued: this.queued,
    };
  }
}
