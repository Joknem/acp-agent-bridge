import assert from "node:assert/strict";
import type { AgentTurn } from "../src/acp/types.js";
import { formatAgentReply, formatErrorReply, formatReplyForPlainText, markdownToPlainText, normalizeMarkdown } from "../src/core/ReplyFormatter.js";

const normalized = normalizeMarkdown("  第一行  \n\n\n第二行\n\n\n");
assert.equal(normalized, "第一行\n\n第二行");

const plain = markdownToPlainText(`# 标题

这是一段 **粗体**、*斜体*、\`code\`、[链接](https://example.com)。

![截图](https://example.com/a.png)

\`\`\`ts
const x = 1;
\`\`\`
`);

assert(plain.includes("标题"));
assert(plain.includes("粗体"));
assert(plain.includes("斜体"));
assert(plain.includes("code"));
assert(plain.includes("链接 (https://example.com)"));
assert(plain.includes("[图片: 截图]"));
assert(plain.includes("```ts"));
assert(plain.includes("const x = 1;"));
assert(!plain.includes("**粗体**"));
assert(!plain.includes("![截图]"));

const turn: AgentTurn = {
  sessionId: "session-a",
  provider: "codex",
  answerMarkdown: "答案\n\n\n- `item`",
  thoughtMarkdown: "",
  toolMarkdown: "",
  stopReason: "end_turn",
};
const agentReply = formatAgentReply(turn);
assert.equal(agentReply.title, "codex 回复");
assert.equal(agentReply.markdown, "答案\n\n- `item`");
assert.equal(formatReplyForPlainText(agentReply), "codex 回复\n\n答案\n\n- item");

const emptyAgentReply = formatAgentReply({ ...turn, answerMarkdown: "", stopReason: "max_turns" });
assert(emptyAgentReply.markdown.includes("max_turns"));

const errorReply = formatErrorReply("acp prompt timeout");
assert.equal(formatReplyForPlainText(errorReply), "执行失败\n\nacp prompt timeout");

console.log("reply formatter tests passed");
