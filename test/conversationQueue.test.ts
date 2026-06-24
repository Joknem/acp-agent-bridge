import assert from "node:assert/strict";
import { ConversationQueue } from "../src/core/ConversationQueue.js";

const queue = new ConversationQueue();
const events: string[] = [];
let releaseFirst: (() => void) | undefined;

const first = queue.enqueue(
  () =>
    new Promise<void>((resolve) => {
      events.push("start:first");
      releaseFirst = () => {
        events.push("finish:first");
        resolve();
      };
    }),
);

const second = queue.enqueue(async () => {
  events.push("start:second");
});

assert.deepEqual(queue.status(), { queued: 2 });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(queue.status(), { queued: 1 });
assert.deepEqual(events, ["start:first"]);

releaseFirst?.();
await first;
await second;
assert.deepEqual(events, ["start:first", "finish:first", "start:second"]);
assert.deepEqual(queue.status(), { queued: 0 });

console.log("conversation queue tests passed");
