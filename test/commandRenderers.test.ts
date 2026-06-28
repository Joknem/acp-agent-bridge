import assert from "node:assert/strict";
import {
  renderAgentList,
  renderAgentUsage,
  renderHelp,
  renderHistory,
  renderLastTurn,
  renderQueue,
  renderRetryAccepted,
  renderRetryUnavailable,
  renderStatus,
  renderTrace,
  renderUnknownCommand,
} from "../src/core/CommandRenderers.js";

testHelp();
testAgentList();
testStatus();
testQueue();
testTurnHistory();
testUnknownAndUsage();

console.log("command renderers tests passed");

function testHelp() {
  const feishu = renderHelp({ mode: "markdown", platform: "feishu" });
  assert(feishu.includes("`/bind new <name> [absolute-path]` 创建新项目并绑定群聊"));
  assert(feishu.includes("`/last` 查看最近一次 agent 任务"));
  assert(feishu.includes("`/history` 查看最近 5 次 agent 任务"));
  assert(feishu.includes("`/trace <turnId>` 查看某次任务的诊断轨迹"));
  assert(feishu.includes("`/retry [turnId]` 重试最近或指定的纯文本任务"));
  assert(feishu.includes("`/ping` 测试飞书收发链路"));

  const qq = renderHelp({ mode: "plain", platform: "qq" });
  assert(qq.includes("/last 查看最近一次 agent 任务"));
  assert(qq.includes("/history 查看最近 5 次 agent 任务"));
  assert(qq.includes("/trace <turnId> 查看某次任务的诊断轨迹"));
  assert(qq.includes("/retry [turnId] 重试最近或指定的纯文本任务"));
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
    allowedCwdRoots: ["/repo"],
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
    controlPolicy: "allowlist",
    controlAllowedUserCount: 2,
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
  assert(rendered.includes("允许 cwd 范围：`/repo`"));
  assert(rendered.includes("绑定项目：`bridge`"));
  assert(rendered.includes("session 状态：`persisted`"));
  assert(rendered.includes("`最近失败：timeout`"));
  assert(rendered.includes("消息去重缓存：`8`"));
  assert(rendered.includes("agent 命令：`codex --model gpt-5 --token <redacted>`"));
  assert(rendered.includes("权限策略：`allow_once`"));
  assert(rendered.includes("控制命令权限：`allowlist，users 2`"));

  const recovered = renderStatus({
    mode: "markdown",
    now: 200_000,
    persistedRuntime: {
      updatedAt: 170_000,
      activeTurn: {
        turnId: "turn-old",
        startedAt: 120_000,
        text: "interrupted task",
      },
      queued: 2,
      pendingBatchCount: 1,
    },
    conversationQueue: { queued: 0 },
    providerQueue: { active: false, queued: 0 },
    currentProvider: "codex",
    currentCwd: "/repo",
    session: {
      providerName: "codex",
      cwd: "/repo",
      persisted: false,
    },
    messageMergeWindowMs: 2_000,
    commands: [],
  });
  assert(recovered.includes("重启前运行态："));
  assert(recovered.includes("turn turn-old"));
}

function testTurnHistory() {
  const turn = {
    turnId: "turn-1",
    platform: "feishu" as const,
    chatId: "chat-a",
    chatType: "p2p",
    provider: "codex",
    cwd: "/repo",
    text: "请帮我检查输出过长的问题\n并给出修复建议",
    retryText: "请帮我检查输出过长的问题\n并给出修复建议",
    status: "error" as const,
    startedAt: 100_000,
    updatedAt: 125_000,
    finishedAt: 125_000,
    durationMs: 25_000,
    sessionId: "session-1",
    errorMessage: "ACP prompt timeout after 1000ms",
    timedOut: true,
    timeoutMs: 1_000,
    cancelAfterTimeout: "succeeded",
    recentStderr: ["stderr line"],
  };

  const last = renderLastTurn({ mode: "markdown", now: 130_000, turn });
  assert(last.includes("最近一次 agent 任务："));
  assert(last.includes("状态：`失败`"));
  assert(last.includes("Turn ID：`turn-1`"));
  assert(last.includes("查看详情：`/trace turn-1`"));
  assert(last.includes("重新执行：`/retry turn-1`"));

  const history = renderHistory({ mode: "plain", now: 130_000, turns: [turn] });
  assert(history.includes("最近 1 次 agent 任务："));
  assert(history.includes("/trace turn-1"));
  assert(history.includes("/retry turn-1"));
  assert(!history.includes("`"));

  const trace = renderTrace({ mode: "plain", now: 130_000, turn });
  assert(trace.includes("任务诊断轨迹："));
  assert(trace.includes("状态：失败"));
  assert(trace.includes("超时：1000ms"));
  assert(trace.includes("- stderr line"));
  assert(!trace.includes("`"));

  const missing = renderTrace({ mode: "markdown", requestedTurnId: "missing" });
  assert(missing.includes("没有找到这个聊天里的 turn：`missing`"));
  assert(missing.includes("`/last`"));

  const accepted = renderRetryAccepted({ mode: "markdown", turn });
  assert(accepted.includes("已加入重试队列。"));
  assert(accepted.includes("原 turn：`turn-1`"));

  const unavailable = renderRetryUnavailable({ mode: "plain", turn: { ...turn, retryText: undefined } });
  assert(unavailable.includes("这个 turn 不能自动重试。"));
  assert(unavailable.includes("图片或附件"));
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
