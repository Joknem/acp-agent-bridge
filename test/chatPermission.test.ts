import assert from "node:assert/strict";
import {
  cancelledPermissionResponse,
  permissionResponseFromCommand,
  renderPermissionRequest,
  type ChatPermissionView,
} from "../src/core/ChatPermission.js";

const request = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "tool-1",
    title: "Edit file",
    kind: "edit" as const,
    status: "pending" as const,
    locations: [{ path: "/repo/file.ts", line: 12 }],
    rawInput: { path: "/repo/file.ts" },
  },
  options: [
    { kind: "allow_once" as const, name: "Allow once", optionId: "allow-once" },
    { kind: "allow_always" as const, name: "Allow always", optionId: "allow-always" },
    { kind: "reject_once" as const, name: "Reject once", optionId: "reject-once" },
  ],
};

assert.deepEqual(permissionResponseFromCommand(request, "approve"), {
  option: request.options[0],
  response: {
    outcome: {
      outcome: "selected",
      optionId: "allow-once",
    },
  },
});

assert.deepEqual(permissionResponseFromCommand(request, "approve", "2"), {
  option: request.options[1],
  response: {
    outcome: {
      outcome: "selected",
      optionId: "allow-always",
    },
  },
});

assert.deepEqual(permissionResponseFromCommand(request, "deny"), {
  option: request.options[2],
  response: {
    outcome: {
      outcome: "selected",
      optionId: "reject-once",
    },
  },
});

assert("error" in permissionResponseFromCommand(request, "approve", "3"));
assert.deepEqual(permissionResponseFromCommand({ ...request, options: request.options.slice(0, 2) }, "deny"), {
  response: cancelledPermissionResponse(),
});

const view: ChatPermissionView = {
  requestId: "perm-1",
  provider: "codex",
  cwd: "/repo",
  sessionId: "session-1",
  turnId: "turn-1",
  expiresAt: Date.now() + 60_000,
  request,
};
const rendered = renderPermissionRequest(view, "markdown");
assert(rendered.includes("`/approve 2`"));
assert(rendered.includes("`/deny 3`"));
assert(rendered.includes("`Edit file`"));

console.log("chat permission tests passed");
