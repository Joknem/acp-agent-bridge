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
  { id: "first", label: "First", summary: "one" },
);

const second = queue.run(async () => {
  events.push("start:second");
  return "second";
}, { id: "second", label: "Second", summary: "two" });

let status = queue.status();
assert.equal(status.active, undefined);
assert.equal(status.queued, 2);
assert.deepEqual(status.pending.map((task) => task.id), ["first", "second"]);
await new Promise((resolve) => setImmediate(resolve));
status = queue.status();
assert.equal(status.active?.id, "first");
assert.equal(status.active?.label, "First");
assert.equal(status.queued, 1);
assert.deepEqual(events, ["start:first"]);

releaseFirst?.();
assert.equal(await first, "first");
assert.equal(await second, "second");
assert.deepEqual(events, ["start:first", "finish:first", "start:second"]);
status = queue.status();
assert.equal(status.active, undefined);
assert.equal(status.queued, 0);
assert.deepEqual(status.pending, []);

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
