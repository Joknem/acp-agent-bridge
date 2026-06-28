import type { AcpAgentProvider, AgentSessionInfo } from "../acp/types.js";
import type { PersistedTurnRecord } from "../state/StateStore.js";
import { truncate } from "../utils/text.js";
import { formatCommandForDisplay } from "./CommandRedaction.js";
import type { QueueStatusSnapshot, QueueTaskSnapshot } from "./QueueSnapshot.js";
import { renderFailureSummary, type TurnFailure } from "./TurnFailure.js";

export type CommandRenderMode = "markdown" | "plain";
export type CommandPlatform = "feishu" | "qq";

export type RenderedAgentProvider = AcpAgentProvider & {
  isDefault?: boolean;
  isRunning?: boolean;
};

export type CommandActiveTurn = {
  turnId: string;
  startedAt: number;
  text: string;
};

export type RenderHelpOptions = {
  mode: CommandRenderMode;
  platform: CommandPlatform;
};

export type RenderAgentListOptions = {
  mode: CommandRenderMode;
  currentProvider: string;
  currentCwd: string;
  providers: RenderedAgentProvider[];
  shortcuts: AgentShortcut[];
};

export type AgentShortcut = {
  label: string;
  command: string;
};

export type RenderStatusOptions = {
  mode: CommandRenderMode;
  now?: number;
  activeTurn?: CommandActiveTurn;
  pendingPermission?: {
    requestId: string;
    toolTitle: string;
    expiresAt: number;
  };
  persistedRuntime?: {
    updatedAt: number;
    activeTurn?: CommandActiveTurn;
    pendingPermission?: {
      requestId: string;
      toolTitle: string;
      expiresAt: number;
    };
    queued: number;
    pendingBatchCount: number;
  };
  pendingBatchCount?: number;
  conversationQueue: {
    queued: number;
  };
  providerQueue: {
    active: boolean;
    queued: number;
  };
  chatType?: string;
  groupBinding?: {
    applicable: boolean;
    bound: boolean;
    cwd?: string;
    projectName?: string;
  };
  currentProvider: string;
  currentCwd: string;
  allowedCwdRoots?: string[];
  session: AgentSessionInfo;
  lastFailure?: TurnFailure;
  currentAgentCommand?: string;
  defaultAgent?: string;
  acpTimeoutMs?: number;
  permissionMode?: string;
  controlPolicy?: string;
  controlAllowedUserCount?: number;
  messageMergeWindowMs: number;
  ack?: {
    mode: string;
    processingReaction?: string;
    doneReaction?: string;
    errorReaction?: string;
  };
  sendTimeoutMs?: number;
  debug?: boolean;
  showThinkingTool?: string;
  logLevel?: string;
  stateFile?: string;
  projectCount?: number;
  bindingCount?: number;
  chatSessionCount?: number;
  processedMessageCount?: number;
  commands: string[];
};

export type RenderQueueOptions = {
  mode: CommandRenderMode;
  now?: number;
  visibleOwner?: string;
  currentProvider: string;
  activeTurn?: CommandActiveTurn;
  pendingBatchCount?: number;
  conversationQueue: QueueStatusSnapshot;
  providerQueues: ProviderQueueView[];
};

export type RenderTurnOptions = {
  mode: CommandRenderMode;
  now?: number;
  turn?: PersistedTurnRecord;
  requestedTurnId?: string;
};

export type RenderHistoryOptions = {
  mode: CommandRenderMode;
  now?: number;
  turns: PersistedTurnRecord[];
};

export type ProviderQueueView = {
  provider: string;
  queue: QueueStatusSnapshot;
};

const FEISHU_HELP: AgentShortcut[] = [
  { command: "/help", label: "查看帮助" },
  { command: "/whoami", label: "查看自己的 sender id" },
  { command: "/status", label: "查看当前聊天状态" },
  { command: "/queue", label: "查看当前聊天和 agent 全局队列" },
  { command: "/last", label: "查看最近一次 agent 任务" },
  { command: "/history", label: "查看最近 5 次 agent 任务" },
  { command: "/trace <turnId>", label: "查看某次任务的诊断轨迹" },
  { command: "/retry [turnId]", label: "重试最近或指定的纯文本任务" },
  { command: "/approve [序号]", label: "批准当前 ACP 权限请求" },
  { command: "/deny [序号]", label: "拒绝当前 ACP 权限请求" },
  { command: "/doctor", label: "运行配置和运行时自检" },
  { command: "/doctor agent|feishu|qq|state|chat", label: "只检查指定范围" },
  { command: "/agent", label: "查看可用 agent" },
  { command: "/agent codex", label: "切换到 Codex" },
  { command: "/agent kimi", label: "切换到 Kimi" },
  { command: "/cwd", label: "查看当前工作目录" },
  { command: "/cwd /absolute/path", label: "切换当前聊天工作目录" },
  { command: "/project", label: "查看项目别名" },
  { command: "/project add <name> [path]", label: "保存项目别名" },
  { command: "/project <name>", label: "切换到项目别名" },
  { command: "/bind <path-or-project>", label: "绑定群聊项目" },
  { command: "/bind new <name> [absolute-path]", label: "创建新项目并绑定群聊" },
  { command: "/unbind", label: "移除群聊项目绑定" },
  { command: "/cancel", label: "取消当前任务" },
  { command: "/reset", label: "重置当前 agent session" },
  { command: "/ping", label: "测试飞书收发链路" },
];

const QQ_HELP: AgentShortcut[] = [
  { command: "/help", label: "查看帮助" },
  { command: "/whoami", label: "查看自己的 sender id" },
  { command: "/status", label: "查看当前聊天状态" },
  { command: "/queue", label: "查看当前聊天和 agent 全局队列" },
  { command: "/last", label: "查看最近一次 agent 任务" },
  { command: "/history", label: "查看最近 5 次 agent 任务" },
  { command: "/trace <turnId>", label: "查看某次任务的诊断轨迹" },
  { command: "/retry [turnId]", label: "重试最近或指定的纯文本任务" },
  { command: "/approve [序号]", label: "批准当前 ACP 权限请求" },
  { command: "/deny [序号]", label: "拒绝当前 ACP 权限请求" },
  { command: "/doctor", label: "运行配置和运行时自检" },
  { command: "/doctor agent|qq|state|chat", label: "只检查指定范围" },
  { command: "/agent", label: "查看可用 agent" },
  { command: "/agent <name>", label: "切换 agent" },
  { command: "/agent switch <name>", label: "切换 agent" },
  { command: "/cancel", label: "取消当前任务" },
  { command: "/reset", label: "重置当前 agent session" },
];

export function renderHelp(options: RenderHelpOptions) {
  const commands = options.platform === "feishu" ? FEISHU_HELP : QQ_HELP;
  const hint =
    options.platform === "feishu"
      ? "提示：控制命令会立即执行。普通消息会按当前聊天串行处理；未绑定群聊会先提示 `/bind`。"
      : "提示：控制命令会立即执行。普通消息会按当前 QQ 会话串行处理。";

  return [
    "常用命令：",
    ...commands.map((item) => `- ${code(item.command, options.mode)} ${item.label}`),
    "",
    renderMarkdownAwareLine(hint, options.mode),
  ].join("\n");
}

export function renderUnknownCommand(token: string, options: RenderHelpOptions) {
  return [`未知命令：${code(token, options.mode)}`, "", renderHelp(options)].join("\n");
}

export function renderAgentUsage(mode: CommandRenderMode) {
  return `用法：${code("/agent <name>", mode)} 或 ${code("/agent switch <name>", mode)}`;
}

export function renderAgentList(options: RenderAgentListOptions) {
  const providers = options.providers.map((provider) => {
    const marks = [
      provider.name === options.currentProvider ? "current" : undefined,
      provider.isDefault ? "default" : undefined,
      provider.isRunning ? "running" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const suffix = marks ? ` (${marks})` : "";
    return `- ${code(provider.name, options.mode)}${suffix}: ${code(formatCommandForDisplay(provider.command, provider.args), options.mode)}`;
  });

  return [
    `当前 agent：${code(options.currentProvider, options.mode)}`,
    `当前 cwd：${code(options.currentCwd, options.mode)}`,
    "",
    "可用 agent：",
    ...providers,
    "",
    ...options.shortcuts.map((item) => `${item.label}：${code(item.command, options.mode)}`),
  ].join("\n");
}

export function renderStatus(options: RenderStatusOptions) {
  const now = options.now ?? Date.now();
  const activeTurn = options.activeTurn;
  const session = options.session;
  const pendingBatchCount = options.pendingBatchCount ?? 0;

  return [
    activeTurn ? `状态：${code(`处理中 ${formatDuration(now - activeTurn.startedAt)}`, options.mode)}` : `状态：${code("空闲", options.mode)}`,
    activeTurn ? `Turn ID：${code(activeTurn.turnId, options.mode)}` : undefined,
    activeTurn ? `正在处理：${code(truncate(activeTurn.text, 80), options.mode)}` : undefined,
    options.pendingPermission
      ? `等待权限：${code(options.pendingPermission.toolTitle, options.mode)} ${code(options.pendingPermission.requestId, options.mode)} ${code(`${Math.max(0, options.pendingPermission.expiresAt - now)}ms`, options.mode)}`
      : undefined,
    !activeTurn && !options.pendingPermission && options.persistedRuntime
      ? renderPersistedRuntime(options.persistedRuntime, options.mode, now)
      : undefined,
    pendingBatchCount > 0 ? `正在合并消息：${code(String(pendingBatchCount), options.mode)}` : undefined,
    `排队消息：${code(String(options.conversationQueue.queued), options.mode)}`,
    `当前 agent 全局队列：${code(`${options.providerQueue.active ? "处理中" : "空闲"}，等待 ${options.providerQueue.queued}`, options.mode)}`,
    options.chatType ? `聊天类型：${code(options.chatType, options.mode)}` : undefined,
    options.groupBinding?.applicable ? `群聊绑定：${code(options.groupBinding.bound ? "已绑定" : "未绑定", options.mode)}` : undefined,
    options.groupBinding?.cwd ? `绑定 cwd：${code(options.groupBinding.cwd, options.mode)}` : undefined,
    options.groupBinding?.projectName ? `绑定项目：${code(options.groupBinding.projectName, options.mode)}` : undefined,
    `当前 agent：${code(options.currentProvider, options.mode)}`,
    `当前 cwd：${code(options.currentCwd, options.mode)}`,
    options.allowedCwdRoots
      ? `允许 cwd 范围：${code(options.allowedCwdRoots.length ? options.allowedCwdRoots.join(", ") : "unrestricted", options.mode)}`
      : undefined,
    session.sessionId ? `当前 session：${code(session.sessionId, options.mode)}` : `当前 session：${code("未创建", options.mode)}`,
    session.sessionId ? `session 状态：${code(renderSessionStatus(session.source, session.persisted), options.mode)}` : undefined,
    options.lastFailure ? renderStatusFailure(options.lastFailure, options.mode, now) : undefined,
    options.currentAgentCommand ? `agent 命令：${code(options.currentAgentCommand, options.mode)}` : undefined,
    options.defaultAgent ? `默认 agent：${code(options.defaultAgent, options.mode)}` : undefined,
    options.acpTimeoutMs !== undefined ? `ACP 超时：${code(`${options.acpTimeoutMs}ms`, options.mode)}` : undefined,
    options.permissionMode ? `权限策略：${code(options.permissionMode, options.mode)}` : undefined,
    options.controlPolicy ? `控制命令权限：${code(`${options.controlPolicy}，users ${options.controlAllowedUserCount ?? 0}`, options.mode)}` : undefined,
    `消息合并窗口：${code(`${options.messageMergeWindowMs}ms`, options.mode)}`,
    options.ack ? `ACK 模式：${code(options.ack.mode, options.mode)}` : undefined,
    options.ack?.mode === "reaction" && options.ack.processingReaction
      ? `处理中 reaction：${code(options.ack.processingReaction, options.mode)}`
      : undefined,
    options.ack?.doneReaction ? `完成 reaction：${code(options.ack.doneReaction, options.mode)}` : undefined,
    options.ack?.errorReaction ? `失败 reaction：${code(options.ack.errorReaction, options.mode)}` : undefined,
    options.sendTimeoutMs !== undefined ? `发送超时：${code(`${options.sendTimeoutMs}ms`, options.mode)}` : undefined,
    options.debug !== undefined ? `debug：${code(String(options.debug), options.mode)}` : undefined,
    options.showThinkingTool ? `thinking/tool：${code(options.showThinkingTool, options.mode)}` : undefined,
    options.logLevel ? `日志级别：${code(options.logLevel, options.mode)}` : undefined,
    options.stateFile ? `状态文件：${code(options.stateFile, options.mode)}` : undefined,
    options.projectCount !== undefined ? `项目别名数：${code(String(options.projectCount), options.mode)}` : undefined,
    options.bindingCount !== undefined ? `群聊绑定数：${code(String(options.bindingCount), options.mode)}` : undefined,
    options.chatSessionCount !== undefined ? `持久化 session：${code(String(options.chatSessionCount), options.mode)}` : undefined,
    options.processedMessageCount !== undefined ? `消息去重缓存：${code(String(options.processedMessageCount), options.mode)}` : undefined,
    "",
    "常用命令：",
    ...options.commands.map((command) => `- ${code(command, options.mode)}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderPersistedRuntime(runtime: NonNullable<RenderStatusOptions["persistedRuntime"]>, mode: CommandRenderMode, now: number) {
  const parts = [
    `updated ${formatDuration(now - runtime.updatedAt)} ago`,
    runtime.activeTurn ? `turn ${runtime.activeTurn.turnId}` : undefined,
    runtime.pendingPermission ? `permission ${runtime.pendingPermission.toolTitle}` : undefined,
    runtime.queued > 0 ? `queued ${runtime.queued}` : undefined,
    runtime.pendingBatchCount > 0 ? `merging ${runtime.pendingBatchCount}` : undefined,
  ].filter(Boolean);

  return parts.length ? `重启前运行态：${code(parts.join("，"), mode)}` : undefined;
}

export function renderQueue(options: RenderQueueOptions) {
  const now = options.now ?? Date.now();
  const activeTurn = options.activeTurn;
  const providerLines = options.providerQueues.flatMap((provider) =>
    renderProviderQueue(provider, options.currentProvider, options.mode, now, options.visibleOwner),
  );

  return [
    "当前聊天队列：",
    activeTurn
      ? `- active turn：${code(activeTurn.turnId, options.mode)} ${code(formatDuration(now - activeTurn.startedAt), options.mode)} ${code(truncate(activeTurn.text, 80), options.mode)}`
      : "- active turn：无",
    options.pendingBatchCount && options.pendingBatchCount > 0
      ? `- 正在合并消息：${code(String(options.pendingBatchCount), options.mode)}`
      : "- 正在合并消息：无",
    `- 会话队列 active：${options.conversationQueue.active ? renderQueueTask(options.conversationQueue.active, options.mode, now, options.visibleOwner) : "无"}`,
    `- 会话队列等待：${code(String(options.conversationQueue.queued), options.mode)}`,
    ...renderPendingTasks(options.conversationQueue.pending, options.mode, now, options.visibleOwner),
    "",
    "Agent 全局队列：",
    ...providerLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderLastTurn(options: RenderTurnOptions) {
  if (!options.turn) {
    return [
      "这个聊天还没有可追踪的 agent 任务。",
      "",
      renderMarkdownAwareLine("发送一条普通消息给 agent 后，可以用 `/last` 查看最近一次结果。", options.mode),
    ].join("\n");
  }

  const turn = options.turn;
  const now = options.now ?? Date.now();
  return [
    "最近一次 agent 任务：",
    `状态：${code(renderTurnStatus(turn.status), options.mode)}`,
    `Turn ID：${code(turn.turnId, options.mode)}`,
    `agent：${code(turn.provider, options.mode)}`,
    `cwd：${code(turn.cwd, options.mode)}`,
    `开始：${code(`${formatDuration(now - turn.startedAt)} ago`, options.mode)}`,
    turn.finishedAt
      ? `耗时：${code(formatDuration(turn.durationMs ?? turn.finishedAt - turn.startedAt), options.mode)}`
      : `已运行：${code(formatDuration(now - turn.startedAt), options.mode)}`,
    turn.stopReason ? `结束原因：${code(turn.stopReason, options.mode)}` : undefined,
    renderTurnSizeLine(turn, options.mode),
    turn.errorMessage ? `错误：${code(truncate(oneLine(turn.errorMessage), 160), options.mode)}` : undefined,
    `输入：${code(truncate(oneLine(turn.text), 120), options.mode)}`,
    "",
    `查看详情：${code(`/trace ${turn.turnId}`, options.mode)}`,
    turn.retryText ? `重新执行：${code(`/retry ${turn.turnId}`, options.mode)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderHistory(options: RenderHistoryOptions) {
  if (!options.turns.length) {
    return [
      "这个聊天还没有可追踪的 agent 任务。",
      "",
      renderMarkdownAwareLine("发送一条普通消息给 agent 后，可以用 `/history` 查看最近任务。", options.mode),
    ].join("\n");
  }

  const now = options.now ?? Date.now();
  return [
    `最近 ${options.turns.length} 次 agent 任务：`,
    ...options.turns.map((turn, index) => renderHistoryTurn(turn, index, options.mode, now)),
    "",
    renderMarkdownAwareLine("用 `/trace <turnId>` 看详情；纯文本任务可用 `/retry <turnId>` 重试。", options.mode),
  ].join("\n");
}

export function renderTrace(options: RenderTurnOptions) {
  if (!options.turn) {
    const suffix = options.requestedTurnId ? `：${code(options.requestedTurnId, options.mode)}` : "";
    return [
      `没有找到这个聊天里的 turn${suffix}。`,
      "",
      renderMarkdownAwareLine("可以先用 `/last` 查看最近一次任务。", options.mode),
    ].join("\n");
  }

  const turn = options.turn;
  const now = options.now ?? Date.now();
  return [
    "任务诊断轨迹：",
    `状态：${code(renderTurnStatus(turn.status), options.mode)}`,
    `Turn ID：${code(turn.turnId, options.mode)}`,
    `平台：${code(turn.platform, options.mode)}`,
    turn.chatType ? `聊天类型：${code(turn.chatType, options.mode)}` : undefined,
    `agent：${code(turn.provider, options.mode)}`,
    `cwd：${code(turn.cwd, options.mode)}`,
    turn.sessionId ? `session：${code(turn.sessionId, options.mode)}` : undefined,
    `开始：${code(`${formatDuration(now - turn.startedAt)} ago`, options.mode)}`,
    turn.finishedAt
      ? `结束：${code(`${formatDuration(now - turn.finishedAt)} ago`, options.mode)}`
      : undefined,
    turn.finishedAt
      ? `耗时：${code(formatDuration(turn.durationMs ?? turn.finishedAt - turn.startedAt), options.mode)}`
      : `已运行：${code(formatDuration(now - turn.startedAt), options.mode)}`,
    turn.stopReason ? `结束原因：${code(turn.stopReason, options.mode)}` : undefined,
    renderTurnSizeLine(turn, options.mode),
    turn.errorMessage ? `错误：${code(truncate(oneLine(turn.errorMessage), 220), options.mode)}` : undefined,
    turn.timedOut ? `超时：${code(`${turn.timeoutMs ?? "unknown"}ms`, options.mode)}` : undefined,
    turn.cancelAfterTimeout ? `超时后取消：${code(turn.cancelAfterTimeout, options.mode)}` : undefined,
    turn.cancelError ? `取消错误：${code(truncate(oneLine(turn.cancelError), 180), options.mode)}` : undefined,
    renderTraceStderr(turn, options.mode),
    "",
    "输入摘要：",
    code(truncate(oneLine(turn.text), 500), options.mode),
    turn.retryText ? "" : undefined,
    turn.retryText
      ? `重新执行：${code(`/retry ${turn.turnId}`, options.mode)}`
      : "重新执行：这次任务包含图片或附件，无法自动复跑原始输入。",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderRetryTargetMissing(options: RenderTurnOptions) {
  const suffix = options.requestedTurnId ? `：${code(options.requestedTurnId, options.mode)}` : "";
  return [
    `没有找到可重试的 turn${suffix}。`,
    "",
    renderMarkdownAwareLine("可以先用 `/history` 查看最近任务。", options.mode),
  ].join("\n");
}

export function renderRetryUnavailable(options: RenderTurnOptions) {
  if (!options.turn) return renderRetryTargetMissing(options);
  return [
    "这个 turn 不能自动重试。",
    "",
    `Turn ID：${code(options.turn.turnId, options.mode)}`,
    "原因：这次任务包含图片或附件，历史里没有保存可复用的原始媒体。",
    "",
    "可以重新发送图片和文字，或复制输入摘要手动发起新任务。",
  ].join("\n");
}

export function renderRetryAccepted(options: RenderTurnOptions) {
  if (!options.turn) return renderRetryTargetMissing(options);
  return [
    "已加入重试队列。",
    "",
    `原 turn：${code(options.turn.turnId, options.mode)}`,
    `输入：${code(truncate(oneLine(options.turn.retryText ?? options.turn.text), 120), options.mode)}`,
    renderMarkdownAwareLine("稍后可以用 `/last` 或 `/history` 查看新任务状态。", options.mode),
  ].join("\n");
}

function renderStatusFailure(failure: TurnFailure, mode: CommandRenderMode, now: number) {
  const summary = renderFailureSummary(failure, now);
  if (mode === "plain") return summary;
  return summary
    .split("\n")
    .map((line) => code(line, mode))
    .join("\n");
}

function renderTurnStatus(status: PersistedTurnRecord["status"]) {
  switch (status) {
    case "running":
      return "处理中";
    case "success":
      return "成功";
    case "error":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function renderHistoryTurn(turn: PersistedTurnRecord, index: number, mode: CommandRenderMode, now: number) {
  const duration = turn.finishedAt
    ? formatDuration(turn.durationMs ?? turn.finishedAt - turn.startedAt)
    : `${formatDuration(now - turn.startedAt)} running`;
  const commands = [code(`/trace ${turn.turnId}`, mode), turn.retryText ? code(`/retry ${turn.turnId}`, mode) : undefined]
    .filter(Boolean)
    .join(" ");
  const marker = turn.retryText ? "" : " no-retry";
  return `${index + 1}. ${code(turn.turnId, mode)} ${renderTurnStatus(turn.status)} ${duration}${marker} ${truncate(oneLine(turn.text), 80)} ${commands}`.trim();
}

function renderTurnSizeLine(turn: PersistedTurnRecord, mode: CommandRenderMode) {
  if (turn.answerChars === undefined && turn.thoughtChars === undefined && turn.toolChars === undefined) return undefined;
  return `输出：${code(`answer ${turn.answerChars ?? 0} chars，thinking ${turn.thoughtChars ?? 0} chars，tool ${turn.toolChars ?? 0} chars`, mode)}`;
}

function renderTraceStderr(turn: PersistedTurnRecord, mode: CommandRenderMode) {
  if (!turn.recentStderr.length) return undefined;
  return ["最近 stderr：", ...turn.recentStderr.map((line) => `- ${code(truncate(oneLine(line), 180), mode)}`)].join("\n");
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function renderSessionStatus(source: string | undefined, persisted: boolean) {
  return [...new Set([source ?? "unknown", persisted ? "persisted" : undefined].filter(Boolean))].join(", ");
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function renderProviderQueue(provider: ProviderQueueView, currentProvider: string, mode: CommandRenderMode, now: number, visibleOwner?: string) {
  const current = provider.provider === currentProvider ? " current" : "";
  return [
    `- ${code(provider.provider, mode)}${current}：${provider.queue.active ? `active ${renderQueueTask(provider.queue.active, mode, now, visibleOwner)}` : "active 无"}，等待 ${code(String(provider.queue.queued), mode)}`,
    ...renderPendingTasks(provider.queue.pending, mode, now, visibleOwner, "  "),
  ];
}

function renderPendingTasks(tasks: QueueTaskSnapshot[], mode: CommandRenderMode, now: number, visibleOwner?: string, prefix = "  ") {
  if (!tasks.length) return [];
  return tasks.slice(0, 5).map((task, index) => `${prefix}${index + 1}. ${renderQueueTask(task, mode, now, visibleOwner)}`);
}

function renderQueueTask(task: QueueTaskSnapshot, mode: CommandRenderMode, now: number, visibleOwner?: string) {
  const age = formatDuration(now - task.enqueuedAt);
  const running = task.startedAt ? ` running ${formatDuration(now - task.startedAt)}` : "";
  const isOtherOwner = Boolean(visibleOwner && task.owner && task.owner !== visibleOwner);
  const id = isOtherOwner ? "other-chat" : task.id;
  const owner = isOtherOwner ? " other chat" : "";
  const summary = !isOtherOwner && task.summary ? ` ${truncate(task.summary, 80)}` : "";
  return `${code(id, mode)} ${task.label}${owner} queued ${age}${running}${summary ? ` ${code(summary.trim(), mode)}` : ""}`;
}

function renderMarkdownAwareLine(line: string, mode: CommandRenderMode) {
  if (mode === "markdown") return line;
  return line.replace(/`([^`]+)`/g, "$1");
}

function code(value: string, mode: CommandRenderMode) {
  if (mode === "plain") return value;
  return `\`${value.replace(/`/g, "'")}\``;
}
