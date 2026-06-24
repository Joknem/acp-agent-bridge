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
  { id: "first", label: "First", summary: "one" },
);

const second = queue.enqueue(async () => {
  events.push("start:second");
}, { id: "second", label: "Second", summary: "two" });

let status = queue.status();
assert.equal(status.queued, 2);
assert.equal(status.active, undefined);
assert.deepEqual(
  status.pending.map((task) => [task.id, task.label, task.summary]),
  [
    ["first", "First", "one"],
    ["second", "Second", "two"],
  ],
);
await new Promise((resolve) => setImmediate(resolve));
status = queue.status();
assert.equal(status.active?.id, "first");
assert.equal(status.queued, 1);
assert.deepEqual(status.pending.map((task) => task.id), ["second"]);
assert.deepEqual(events, ["start:first"]);

releaseFirst?.();
await first;
await second;
assert.deepEqual(events, ["start:first", "finish:first", "start:second"]);
status = queue.status();
assert.equal(status.active, undefined);
assert.equal(status.queued, 0);
assert.deepEqual(status.pending, []);

console.log("conversation queue tests passed");
