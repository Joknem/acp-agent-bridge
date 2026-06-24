import assert from "node:assert/strict";
import type { AgentTurn } from "../src/acp/types.js";
import { ReplyAdapter } from "../src/core/ReplyAdapter.js";

const richCalls: Array<{ destination: string; markdown: string; title?: string }> = [];
const richAdapter = new ReplyAdapter<string>({
  mode: "markdown",
  sendMarkdown: async (destination, markdown, title) => {
    richCalls.push({ destination, markdown, title });
  },
  sendPlainText: async () => {
    throw new Error("plain text fallback should not be used");
  },
});

await richAdapter.sendMarkdown("chat-a", "**你好**", "问候");
assert.deepEqual(richCalls, [{ destination: "chat-a", markdown: "**你好**", title: "问候" }]);

let fallbackError = "";
let fallbackText = "";
const fallbackAdapter = new ReplyAdapter<string>({
  mode: "markdown",
  sendMarkdown: async () => {
    throw new Error("card failed");
  },
  sendPlainText: async (_destination, text) => {
    fallbackText = text;
  },
  onMarkdownSendError: (error) => {
    fallbackError = error instanceof Error ? error.message : String(error);
  },
});

await fallbackAdapter.sendMarkdown("chat-b", "**你好**", "问候");
assert.equal(fallbackError, "card failed");
assert.equal(fallbackText, "问候\n\n你好");

let plainText = "";
const plainAdapter = new ReplyAdapter<string>({
  mode: "plain-text",
  sendMarkdown: async () => {
    throw new Error("markdown sender should not be used");
  },
  sendPlainText: async (_destination, text) => {
    plainText = text;
  },
});

const turn: AgentTurn = {
  sessionId: "session-a",
  provider: "codex",
  answerMarkdown: "看 [README](README.md) 和 `src/index.ts`",
  thoughtMarkdown: "",
  toolMarkdown: "",
  stopReason: "end_turn",
};

await plainAdapter.sendAgent("chat-c", turn);
assert.equal(plainText, "codex 回复\n\n看 README (README.md) 和 src/index.ts");

console.log("reply adapter tests passed");
