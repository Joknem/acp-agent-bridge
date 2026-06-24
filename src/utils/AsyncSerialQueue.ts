import { cloneQueueTask, createQueueTask, type QueueStatusSnapshot, type QueueTaskMetadata, type QueueTaskSnapshot } from "../core/QueueSnapshot.js";

export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private nextTaskId = 1;
  private active?: QueueTaskSnapshot;
  private readonly pending: QueueTaskSnapshot[] = [];

  run<T>(work: () => Promise<T>, metadata: QueueTaskMetadata = {}): Promise<T> {
    const task = createQueueTask(this.nextTaskId++, metadata);
    this.pending.push(task);

    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.removePending(task.id);
        this.active = { ...task, startedAt: Date.now() };
        try {
          return await work();
        } finally {
          if (this.active?.id === task.id) this.active = undefined;
        }
      });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  status(): QueueStatusSnapshot {
    return {
      active: this.active ? cloneQueueTask(this.active) : undefined,
      queued: this.pending.length,
      pending: this.pending.map(cloneQueueTask),
    };
  }

  private removePending(taskId: string) {
    const index = this.pending.findIndex((task) => task.id === taskId);
    if (index >= 0) this.pending.splice(index, 1);
  }
}
