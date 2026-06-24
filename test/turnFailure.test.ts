import assert from "node:assert/strict";
import { AgentPromptError } from "../src/acp/types.js";
import { createTurnFailure, renderFailureSummary } from "../src/core/TurnFailure.js";

const error = new AgentPromptError("ACP prompt timeout after 1000ms", {
  provider: "codex",
  cwd: "/tmp/project",
  sessionId: "session-a",
  turnId: "turn-a",
  timedOut: true,
  timeoutMs: 1000,
  cancelAfterTimeout: "failed",
  cancelError: "cancel failed",
  recentStderr: ["stderr-a", "stderr-b"],
});

const failure = createTurnFailure(error, { text: "long task" }, 10_000);
assert.equal(failure.turnId, "turn-a");
assert.equal(failure.provider, "codex");
assert.equal(failure.cwd, "/tmp/project");
assert.equal(failure.sessionId, "session-a");
assert.equal(failure.timedOut, true);
assert.equal(failure.timeoutMs, 1000);
assert.equal(failure.cancelAfterTimeout, "failed");
assert.equal(failure.cancelError, "cancel failed");
assert.deepEqual(failure.recentStderr, ["stderr-a", "stderr-b"]);

const summary = renderFailureSummary(failure, 12_500);
assert(summary.includes("ACP prompt timeout"));
assert(summary.includes("turn-a"));
assert(summary.includes("codex"));
assert(summary.includes("2s"));

const generic = createTurnFailure(new Error("boom"), { turnId: "turn-b", provider: "kimi", cwd: "/tmp/other" }, 20_000);
assert.equal(generic.message, "boom");
assert.equal(generic.turnId, "turn-b");
assert.equal(generic.provider, "kimi");

console.log("turn failure tests passed");
