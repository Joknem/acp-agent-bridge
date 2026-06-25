import assert from "node:assert/strict";
import { renderAgentList, renderAgentUsage, renderHelp, renderQueue, renderStatus, renderUnknownCommand } from "../src/core/CommandRenderers.js";

testHelp();
testAgentList();
testStatus();
testQueue();
testUnknownAndUsage();

console.log("command renderers tests passed");

function testHelp() {
  const feishu = renderHelp({ mode: "markdown", platform: "feishu" });
  assert(feishu.includes("`/bind new <name> [absolute-path]` 创建新项目并绑定群聊"));
  assert(feishu.includes("`/ping` 测试飞书收发链路"));

  const qq = renderHelp({ mode: "plain", platform: "qq" });
  assert(qq.includes("/doctor agent|qq|state|chat 只检查指定范围"));
  assert(!qq.includes("`"));
  assert(!qq.includes("/bind"));
}

function testAgentList() {
  const rendered = renderAgentList({
    mode: "markdown",
    currentProvider: "codex",
    currentCwd: "/repo",
    providers: [
      { name: "codex", command: "codex", args: ["--model", "gpt-5", "--api-key", "sk-live-secretsecret"], isDefault: true, isRunning: true },
      { name: "kimi", command: "kimi", args: [], isDefault: false, isRunning: false },
    ],
    shortcuts: [{ label: "切换 agent", command: "/agent <name>" }],
  });

  assert(rendered.includes("当前 agent：`codex`"));
  assert(rendered.includes("- `codex` (current, default, running): `codex --model gpt-5 --api-key <redacted>`"));
  assert(!rendered.includes("sk-live-secretsecret"));
  assert(rendered.includes("切换 agent：`/agent <name>`"));
}

function testStatus() {
  const rendered = renderStatus({
    mode: "markdown",
    now: 160_000,
    activeTurn: {
      turnId: "turn-1",
      startedAt: 100_000,
      text: "正在处理的较长消息",
    },
    pendingPermission: {
      requestId: "perm-1",
      toolTitle: "Edit file",
      expiresAt: 175_000,
    },
    pendingBatchCount: 2,
    conversationQueue: { queued: 1 },
    providerQueue: { active: true, queued: 3 },
    chatType: "group",
    groupBinding: {
      applicable: true,
      bound: true,
      cwd: "/repo",
      projectName: "bridge",
    },
    currentProvider: "codex",
    currentCwd: "/repo",
    session: {
      providerName: "codex",
      cwd: "/repo",
      sessionId: "session-1",
      source: "persisted",
      persisted: true,
    },
    lastFailure: {
      message: "timeout",
      failedAt: 130_000,
      turnId: "turn-0",
      provider: "codex",
    },
    currentAgentCommand: "codex --model gpt-5 --token <redacted>",
    defaultAgent: "codex",
    acpTimeoutMs: 600_000,
    permissionMode: "allow_once",
    messageMergeWindowMs: 2_000,
    ack: { mode: "reaction", processingReaction: "THINKING", doneReaction: "DONE" },
    sendTimeoutMs: 15_000,
    debug: false,
    showThinkingTool: "auto",
    logLevel: "info",
    stateFile: "/repo/state.json",
    projectCount: 2,
    bindingCount: 1,
    chatSessionCount: 4,
    processedMessageCount: 8,
    commands: ["/help", "/status"],
  });

  assert(rendered.includes("状态：`处理中 1m00s`"));
  assert(rendered.includes("等待权限：`Edit file` `perm-1` `15000ms`"));
  assert(rendered.includes("当前 agent 全局队列：`处理中，等待 3`"));
  assert(rendered.includes("绑定项目：`bridge`"));
  assert(rendered.includes("session 状态：`persisted`"));
  assert(rendered.includes("`最近失败：timeout`"));
  assert(rendered.includes("消息去重缓存：`8`"));
  assert(rendered.includes("agent 命令：`codex --model gpt-5 --token <redacted>`"));
  assert(rendered.includes("权限策略：`allow_once`"));
}

function testQueue() {
  const rendered = renderQueue({
    mode: "plain",
    now: 70_000,
    visibleOwner: "chat-a",
    currentProvider: "codex",
    activeTurn: {
      turnId: "turn-1",
      startedAt: 10_000,
      text: "active prompt",
    },
    pendingBatchCount: 1,
    conversationQueue: {
      active: {
        id: "conv-active",
        kind: "message_batch",
        label: "消息批次",
        summary: "active prompt",
        owner: "chat-a",
        enqueuedAt: 5_000,
        startedAt: 10_000,
      },
      queued: 1,
      pending: [
        {
          id: "conv-pending",
          kind: "message_batch",
          label: "消息批次",
          summary: "pending prompt",
          owner: "chat-a",
          enqueuedAt: 60_000,
        },
      ],
    },
    providerQueues: [
      {
        provider: "codex",
        queue: {
          active: {
            id: "turn-1",
            kind: "agent_prompt",
            label: "codex prompt",
            summary: "active prompt",
            owner: "chat-a",
            enqueuedAt: 20_000,
            startedAt: 30_000,
          },
          queued: 0,
          pending: [],
        },
      },
      {
        provider: "kimi",
        queue: {
          active: {
            id: "turn-other",
            kind: "agent_prompt",
            label: "kimi prompt",
            summary: "private other chat prompt",
            owner: "chat-b",
            enqueuedAt: 50_000,
            startedAt: 55_000,
          },
          queued: 0,
          pending: [],
        },
      },
    ],
  });

  assert(rendered.includes("当前聊天队列："));
  assert(rendered.includes("active turn：turn-1 1m00s active prompt"));
  assert(rendered.includes("会话队列等待：1"));
  assert(rendered.includes("conv-pending 消息批次 queued 10s pending prompt"));
  assert(rendered.includes("codex current"));
  assert(rendered.includes("turn-1 codex prompt queued 50s running 40s active prompt"));
  assert(rendered.includes("other-chat kimi prompt other chat queued 20s running 15s"));
  assert(!rendered.includes("private other chat prompt"));
}

function testUnknownAndUsage() {
  assert.equal(renderAgentUsage("plain"), "用法：/agent <name> 或 /agent switch <name>");
  assert(renderUnknownCommand("/wat", { mode: "plain", platform: "qq" }).startsWith("未知命令：/wat"));
}
