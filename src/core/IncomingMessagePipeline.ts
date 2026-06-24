import { ConversationQueue } from "./ConversationQueue.js";
import { MessageBatcher } from "./MessageBatcher.js";
import type { QueueTaskMetadata } from "./QueueSnapshot.js";

export type IncomingPipelineState<TItem> = {
  queue: ConversationQueue;
  pendingBatcher?: MessageBatcher<TItem>;
};

type BatchEvent<TItem> = {
  chatId: string;
  items: TItem[];
  state: IncomingPipelineState<TItem>;
  summary: string;
};

type PipelineOptions<TItem> = {
  mergeWindowMs: number;
  summarize: (items: TItem[]) => string;
  onBatchQueued?: (event: BatchEvent<TItem>) => void;
  processBatch: (event: BatchEvent<TItem>) => Promise<void>;
  onBatchError?: (error: unknown, event: BatchEvent<TItem>) => Promise<void> | void;
};

export class IncomingMessagePipeline<TItem> {
  constructor(private readonly options: PipelineOptions<TItem>) {}

  createState(): IncomingPipelineState<TItem> {
    return {
      queue: new ConversationQueue(),
    };
  }

  stop(state: IncomingPipelineState<TItem>) {
    state.pendingBatcher?.stop();
    state.pendingBatcher = undefined;
  }

  flush(state: IncomingPipelineState<TItem>) {
    state.pendingBatcher?.flush();
  }

  enqueueImmediate(chatId: string, state: IncomingPipelineState<TItem>, work: () => Promise<void>, metadata: QueueTaskMetadata = {}) {
    this.flush(state);
    return state.queue.enqueue(work, {
      kind: "command",
      label: "控制命令",
      ...metadata,
    });
  }

  schedule(chatId: string, state: IncomingPipelineState<TItem>, item: TItem) {
    state.pendingBatcher ??= new MessageBatcher(this.options.mergeWindowMs, (items) => {
      this.enqueueBatch(chatId, state, items);
    });
    state.pendingBatcher.add(item);
  }

  private enqueueBatch(chatId: string, state: IncomingPipelineState<TItem>, items: TItem[]) {
    const event: BatchEvent<TItem> = {
      chatId,
      items,
      state,
      summary: this.options.summarize(items),
    };

    this.options.onBatchQueued?.(event);

    return state.queue.enqueue(
      async () => {
        try {
          await this.options.processBatch(event);
        } catch (error: unknown) {
          if (!this.options.onBatchError) throw error;
          await this.options.onBatchError(error, event);
        }
      },
      {
        kind: "message_batch",
        label: "消息批次",
        summary: event.summary,
        owner: chatId,
      },
    );
  }
}
