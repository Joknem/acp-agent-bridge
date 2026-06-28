import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state/StateStore.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-agent-state-"));
const filePath = path.join(dir, "state.json");

await fs.writeFile(
  filePath,
  `${JSON.stringify({
    version: 1,
    chats: {
      chat_a: {
        providerName: "codex",
        cwd: "/tmp/project-a",
        sessions: {
          codex: {
            sessionId: "session-a",
            cwd: "/tmp/project-a",
            createdAt: 100,
            updatedAt: 200,
          },
        },
      },
    },
    projects: {
      acp: "/tmp/acp-create",
    },
  })}\n`,
  "utf8",
);

const store = new StateStore(filePath, logger);
await store.load();

assert.deepEqual(store.listBindings(), []);
assert.equal(store.getChat("chat_a")?.providerName, "codex");
assert.equal(store.getChatSession("chat_a", "CODEX")?.sessionId, "session-a");
assert.equal(store.chatSessionCount(), 1);
assert.equal(store.getProject("ACP"), "/tmp/acp-create");

store.setChatSession("chat_a", "codex", {
  sessionId: "session-b",
  cwd: "/tmp/project-a",
  resumed: true,
});
await store.flush();

const resumedSession = store.getChatSession("chat_a", "codex");
assert.equal(resumedSession?.sessionId, "session-b");
assert.equal(resumedSession?.createdAt, 100);
assert.equal(typeof resumedSession?.resumedAt, "number");
assert.equal(store.deleteChatSession("chat_a", "kimi"), false);
assert.equal(store.deleteChatSession("chat_a", "codex"), true);
assert.equal(store.chatSessionCount(), 0);

store.setChatSession("chat_a", "codex", {
  sessionId: "session-c",
  cwd: "/tmp/project-a",
});
store.setChatSession("chat_b", "kimi", {
  sessionId: "session-d",
  cwd: "/tmp/project-b",
});
await store.flush();
assert.equal(store.chatSessionCount(), 2);
assert.equal(store.clearChatSessions("chat_a"), 1);
assert.equal(store.clearChatSessions("missing"), 0);
assert.equal(store.chatSessionCount(), 1);

store.setBinding("group_a", {
  cwd: "/tmp/acp-create",
  projectName: "acp",
});
await store.flush();

const binding = store.getBinding("group_a");
assert.equal(binding?.cwd, "/tmp/acp-create");
assert.equal(binding?.projectName, "acp");
assert.equal(typeof binding?.createdAt, "number");
assert.equal(typeof binding?.updatedAt, "number");
assert.equal(store.listBindings().length, 1);

assert.equal(store.processedMessageCount(), 0);
assert.equal(store.markProcessedMessage("feishu:message-a", 1_000), true);
assert.equal(store.markProcessedMessage("feishu:message-a", 2_000), false);
assert.equal(store.markProcessedMessage("qq:message-a", 3_000), true);
assert.equal(store.processedMessageCount(), 2);

assert.equal(store.runtimeStats().chats, 0);
store.setChatRuntime("chat_a", {
  platform: "feishu",
  chatType: "p2p",
  activeTurn: {
    turnId: "turn-a",
    provider: "codex",
    cwd: "/tmp/project-a",
    text: "work in progress",
    startedAt: 10_000,
  },
  pendingPermission: {
    requestId: "perm-a",
    provider: "codex",
    cwd: "/tmp/project-a",
    sessionId: "session-c",
    turnId: "turn-a",
    toolTitle: "Edit file",
    toolKind: "edit",
    expiresAt: 70_000,
    optionCount: 3,
  },
  pendingBatchCount: 1,
  conversationQueue: {
    queued: 1,
    pending: [
      {
        id: "queue-a",
        kind: "message_batch",
        label: "消息批次",
        summary: "queued work",
        owner: "chat_a",
        enqueuedAt: 11_000,
      },
    ],
  },
});
await store.flush();
assert.equal(store.getChatRuntime("chat_a")?.activeTurn?.turnId, "turn-a");
assert.equal(store.runtimeStats().chats, 1);
assert.equal(store.runtimeStats().activeTurns, 1);
assert.equal(store.runtimeStats().pendingPermissions, 1);
assert.equal(store.runtimeStats().queuedMessages, 1);
assert.equal(store.runtimeStats().pendingBatches, 1);
assert.equal(store.clearChatRuntime("chat_a"), true);
assert.equal(store.clearChatRuntime("chat_a"), false);

assert.equal(store.turnHistoryCount(), 0);
store.recordTurnStarted({
  turnId: "turn-history-a",
  platform: "feishu",
  chatId: "chat_a",
  chatType: "p2p",
  provider: "codex",
  cwd: "/tmp/project-a",
  text: "first task",
  retryText: "first task",
  startedAt: 100_000,
});
store.recordTurnCompleted("turn-history-a", {
  status: "success",
  finishedAt: 103_000,
  sessionId: "session-history-a",
  stopReason: "end_turn",
  answerChars: 12,
  thoughtChars: 3,
  toolChars: 4,
});
store.recordTurnStarted({
  turnId: "turn-history-b",
  platform: "qq",
  chatId: "chat_b",
  provider: "kimi",
  cwd: "/tmp/project-b",
  text: "second task",
  startedAt: 104_000,
});
store.recordTurnCompleted("turn-history-b", {
  status: "error",
  finishedAt: 106_000,
  errorMessage: "ACP prompt timeout after 1000ms",
  timedOut: true,
  timeoutMs: 1_000,
  cancelAfterTimeout: "succeeded",
  recentStderr: ["line 1", "line 2"],
});
await store.flush();

assert.equal(store.turnHistoryCount(), 2);
assert.equal(store.getLastTurn("chat_a")?.turnId, "turn-history-a");
assert.equal(store.getTurnForChat("chat_a", "turn-history-b"), undefined);
assert.equal(store.getTurnForChat("chat_b", "turn-history-b")?.status, "error");
assert.equal(store.getTurn("turn-history-a")?.durationMs, 3_000);
assert.equal(store.getTurn("turn-history-a")?.retryText, "first task");
assert.equal(store.listTurns("chat_b").length, 1);

assert.equal(store.deleteBinding("group_a"), true);
assert.equal(store.deleteBinding("group_a"), false);
await store.flush();
assert.equal(store.getBinding("group_a"), undefined);

console.log("state store tests passed");
