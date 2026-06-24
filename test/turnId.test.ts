import assert from "node:assert/strict";
import { createTurnId } from "../src/core/TurnId.js";

const first = createTurnId("qq");
const second = createTurnId("qq");
const feishu = createTurnId("feishu");

assert.match(first, /^qq-[a-z0-9]+-[a-z0-9]+$/);
assert.match(feishu, /^feishu-[a-z0-9]+-[a-z0-9]+$/);
assert.notEqual(first, second);

console.log("turn id tests passed");
