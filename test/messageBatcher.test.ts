import assert from "node:assert/strict";
import { MessageBatcher } from "../src/core/MessageBatcher.js";

const flushed: number[][] = [];
const batcher = new MessageBatcher<number>(20, (items) => {
  flushed.push(items);
});

batcher.add(1);
batcher.add(2);
assert.equal(batcher.pendingCount(), 2);
assert.equal(batcher.hasPending(), true);

await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(flushed, [[1, 2]]);
assert.equal(batcher.pendingCount(), 0);
assert.equal(batcher.hasPending(), false);

batcher.add(3);
batcher.flush();
assert.deepEqual(flushed, [[1, 2], [3]]);

const immediate: string[][] = [];
const immediateBatcher = new MessageBatcher<string>(0, (items) => {
  immediate.push(items);
});
immediateBatcher.add("a");
assert.deepEqual(immediate, [["a"]]);

console.log("message batcher tests passed");
