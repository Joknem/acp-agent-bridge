import assert from "node:assert/strict";
import { AsyncSerialQueue } from "../src/utils/AsyncSerialQueue.js";

const queue = new AsyncSerialQueue();
const events: string[] = [];
let releaseFirst: (() => void) | undefined;

const first = queue.run(
  () =>
    new Promise<string>((resolve) => {
      events.push("start:first");
      releaseFirst = () => {
        events.push("finish:first");
        resolve("first");
      };
    }),
);

const second = queue.run(async () => {
  events.push("start:second");
  return "second";
});

assert.deepEqual(queue.status(), { active: false, queued: 2 });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(queue.status(), { active: true, queued: 1 });
assert.deepEqual(events, ["start:first"]);

releaseFirst?.();
assert.equal(await first, "first");
assert.equal(await second, "second");
assert.deepEqual(events, ["start:first", "finish:first", "start:second"]);
assert.deepEqual(queue.status(), { active: false, queued: 0 });

await assert.rejects(
  queue.run(async () => {
    events.push("start:error");
    throw new Error("boom");
  }),
  /boom/,
);

assert.equal(
  await queue.run(async () => {
    events.push("start:after-error");
    return "ok";
  }),
  "ok",
);

assert.deepEqual(events.slice(-2), ["start:error", "start:after-error"]);

console.log("async serial queue tests passed");
