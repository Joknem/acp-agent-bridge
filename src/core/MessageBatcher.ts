export class MessageBatcher<T> {
  private items: T[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: (items: T[]) => void,
  ) {}

  add(item: T) {
    this.items.push(item);

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.windowMs === 0) {
      this.flush();
      return;
    }

    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (!this.items.length) return;

    const items = this.items;
    this.items = [];
    this.onFlush(items);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }

  pendingCount() {
    return this.items.length;
  }

  hasPending() {
    return this.items.length > 0;
  }
}
