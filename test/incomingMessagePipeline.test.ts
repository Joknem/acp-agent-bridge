import assert from "node:assert/strict";
import { IncomingMessagePipeline } from "../src/core/IncomingMessagePipeline.js";

const queued: string[] = [];
const processed: string[] = [];
const pipeline = new IncomingMessagePipeline<number>({
  mergeWindowMs: 20,
  summarize: (items) => items.join(","),
  onBatchQueued: (event) => queued.push(`${event.chatId}:${event.summary}`),
  processBatch: async (event) => {
    processed.push(`batch:${event.items.join(",")}`);
  },
});

const state = pipeline.createState();
pipeline.schedule("chat-a", state, 1);
pipeline.schedule("chat-a", state, 2);
assert.equal(state.pendingBatcher?.pendingCount(), 2);

await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(queued, ["chat-a:1,2"]);
assert.deepEqual(processed, ["batch:1,2"]);
assert.equal(state.queue.status().queued, 0);

pipeline.schedule("chat-a", state, 3);
await pipeline.enqueueImmediate("chat-a", state, async () => {
  processed.push("immediate");
}, { id: "command-1", summary: "/status" });
assert.deepEqual(processed.slice(-2), ["batch:3", "immediate"]);

pipeline.schedule("chat-a", state, 4);
pipeline.stop(state);
assert.equal(state.pendingBatcher, undefined);
assert.deepEqual(processed, ["batch:1,2", "batch:3", "immediate"]);

const errors: string[] = [];
const errorPipeline = new IncomingMessagePipeline<string>({
  mergeWindowMs: 0,
  summarize: (items) => items.join("/"),
  processBatch: async () => {
    throw new Error("boom");
  },
  onBatchError: (error, event) => {
    errors.push(`${event.chatId}:${event.summary}:${error instanceof Error ? error.message : String(error)}`);
  },
});

const errorState = errorPipeline.createState();
errorPipeline.schedule("chat-b", errorState, "x");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(errors, ["chat-b:x:boom"]);

console.log("incoming message pipeline tests passed");
