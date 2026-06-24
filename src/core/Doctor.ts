import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AcpAgentProvider } from "../acp/types.js";

export type DoctorScope = "all" | "config" | "agent" | "state" | "feishu" | "qq" | "chat";

export type DoctorItem = {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
};

export type DoctorSection = {
  title: string;
  items: DoctorItem[];
};

export type DoctorReport = {
  scope: DoctorScope;
  sections: DoctorSection[];
};

export type DoctorProvider = AcpAgentProvider & {
  isDefault?: boolean;
  isRunning?: boolean;
};

export type DoctorChat = {
  chatId: string;
  chatType?: string;
  currentProvider: string;
  currentCwd: string;
  queued: number;
  pendingBatchCount?: number;
  activeText?: string;
  binding?: {
    cwd: string;
    projectName?: string;
  };
};

export type DoctorPlatformStatus = {
  feishu?: DoctorItem[];
  qq?: DoctorItem[];
};

export type DoctorStateStats = {
  projects: number;
  bindings: number;
  processedMessages: number;
};

export type DoctorInput = {
  config: AppConfig;
  providers: DoctorProvider[];
  state: DoctorStateStats;
  chat?: DoctorChat;
  platform?: DoctorPlatformStatus;
  scope?: DoctorScope;
  pathEnv?: string;
};

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const scope = input.scope ?? "all";
  const sections = await Promise.all([
    includeScope(scope, "config") ? buildConfigSection(input.config) : undefined,
    includeScope(scope, "agent") ? buildAgentSection(input.providers, input.config, input.pathEnv) : undefined,
    includeScope(scope, "state") ? buildStateSection(input.config, input.state) : undefined,
    includeScope(scope, "feishu") ? buildFeishuSection(input.config, input.platform?.feishu) : undefined,
    includeScope(scope, "qq") ? buildQqSection(input.config, input.platform?.qq) : undefined,
    includeScope(scope, "chat") && input.chat ? buildChatSection(input.chat) : undefined,
  ]);

  return {
    scope,
    sections: sections.filter((section): section is DoctorSection => Boolean(section)),
  };
}

export function parseDoctorScope(value: string | undefined): DoctorScope {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "config":
    case "agent":
    case "agents":
    case "state":
    case "feishu":
    case "qq":
    case "chat":
      return normalized === "agents" ? "agent" : normalized;
    default:
      return "all";
  }
}

export function formatDoctorReport(report: DoctorReport) {
  const items = report.sections.flatMap((section) => section.items);
  const ok = items.filter((item) => item.status === "ok").length;
  const warn = items.filter((item) => item.status === "warn").length;
  const fail = items.filter((item) => item.status === "fail").length;
  const lines = [
    "诊断结果",
    `范围：\`${report.scope}\``,
    `汇总：OK \`${ok}\`，WARN \`${warn}\`，FAIL \`${fail}\``,
  ];

  for (const section of report.sections) {
    lines.push("", `## ${section.title}`);
    for (const item of section.items) {
      lines.push(`- ${statusLabel(item.status)} ${item.label}：${item.detail}`);
    }
  }

  return lines.join("\n");
}

function includeScope(current: DoctorScope, section: DoctorScope) {
  return current === "all" || current === section;
}

async function buildConfigSection(config: AppConfig): Promise<DoctorSection> {
  const cwd = await directoryItem("默认 cwd", config.acp.cwd);
  const items: DoctorItem[] = [
    cwd,
    config.acp.promptTimeoutMs < 60_000
      ? warn("ACP 超时", `${config.acp.promptTimeoutMs}ms 偏短，长任务容易超时`)
      : ok("ACP 超时", `${config.acp.promptTimeoutMs}ms`),
    config.messageMergeWindowMs === 0
      ? warn("飞书消息合并", "已关闭，图片和说明文字可能被拆成两次 prompt")
      : ok("飞书消息合并", `${config.messageMergeWindowMs}ms`),
    ok("ACK 模式", config.ackMode),
    ok("日志级别", config.logLevel),
  ];

  return { title: "配置", items };
}

async function buildAgentSection(providers: DoctorProvider[], config: AppConfig, pathEnv = process.env.PATH ?? ""): Promise<DoctorSection> {
  const items: DoctorItem[] = [];
  const defaultProvider = providers.find((provider) => provider.name === config.acp.defaultAgent);

  items.push(defaultProvider ? ok("默认 agent", config.acp.defaultAgent) : fail("默认 agent", `未找到：${config.acp.defaultAgent}`));

  for (const provider of providers) {
    const resolved = await resolveCommand(provider.command, pathEnv);
    const suffix = [provider.isDefault ? "default" : undefined, provider.isRunning ? "running" : undefined]
      .filter(Boolean)
      .join(", ");
    const label = `agent ${provider.name}${suffix ? ` (${suffix})` : ""}`;

    items.push(
      resolved
        ? ok(label, `${provider.command} -> \`${resolved}\`${renderAgentConfig(provider.args)}`)
        : fail(label, `找不到可执行命令：\`${provider.command}\``),
    );
  }

  return { title: "Agent", items };
}

async function buildStateSection(config: AppConfig, state: DoctorStateStats): Promise<DoctorSection> {
  return {
    title: "状态文件",
    items: [
      await stateFileItem(config.stateFile),
      ok("项目别名", String(state.projects)),
      ok("群聊绑定", String(state.bindings)),
      ok("消息去重缓存", String(state.processedMessages)),
    ],
  };
}

function buildFeishuSection(config: AppConfig, platformItems: DoctorItem[] | undefined): DoctorSection {
  return {
    title: "飞书",
    items: [
      ok("App ID", maskValue(config.feishu.appId)),
      ok("Domain", config.feishu.domain),
      ...(platformItems ?? [warn("凭证实时检查", "当前平台没有提供实时检查结果")]),
    ],
  };
}

function buildQqSection(config: AppConfig, platformItems: DoctorItem[] | undefined): DoctorSection {
  const authMode = config.qq.appSecret ? "AppSecret access token" : config.qq.token ? "legacy token" : "未配置";
  const items: DoctorItem[] = [
    config.qq.enabled ? ok("启用状态", "已启用") : warn("启用状态", "未启用"),
    config.qq.enabled && !config.qq.appId ? fail("App ID", "未配置") : ok("App ID", config.qq.appId ? maskValue(config.qq.appId) : "空"),
    config.qq.enabled && authMode === "未配置" ? fail("鉴权方式", "未配置 AppSecret 或 legacy token") : ok("鉴权方式", authMode),
    ok("API Base", config.qq.apiBase),
    ok("Intents", String(config.qq.intents)),
    config.qq.messageMergeWindowMs === 0
      ? warn("QQ 消息合并", "已关闭，图片和说明文字可能被拆成两次 prompt")
      : ok("QQ 消息合并", `${config.qq.messageMergeWindowMs}ms`),
    ...(platformItems ?? [warn("Gateway 实时状态", "当前平台没有提供实时检查结果")]),
  ];

  return { title: "QQ", items };
}

function buildChatSection(chat: DoctorChat): DoctorSection {
  return {
    title: "当前聊天",
    items: [
      ok("Chat ID", chat.chatId),
      chat.chatType ? ok("聊天类型", chat.chatType) : warn("聊天类型", "未知"),
      ok("当前 agent", chat.currentProvider),
      ok("当前 cwd", `\`${chat.currentCwd}\``),
      ok("排队消息", String(chat.queued)),
      chat.pendingBatchCount ? ok("正在合并消息", String(chat.pendingBatchCount)) : ok("正在合并消息", "0"),
      chat.activeText ? warn("当前任务", chat.activeText) : ok("当前任务", "无"),
      chat.binding ? ok("绑定项目", `${chat.binding.projectName ? `${chat.binding.projectName} -> ` : ""}\`${chat.binding.cwd}\``) : warn("绑定项目", "未绑定"),
    ],
  };
}

async function directoryItem(label: string, directory: string): Promise<DoctorItem> {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) return fail(label, `不是目录：\`${directory}\``);
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
    return ok(label, `\`${directory}\``);
  } catch (error: unknown) {
    return fail(label, `${errorMessage(error)}：\`${directory}\``);
  }
}

async function stateFileItem(filePath: string): Promise<DoctorItem> {
  const directory = path.dirname(filePath);
  try {
    await fs.access(filePath, fsConstants.R_OK | fsConstants.W_OK);
    return ok("状态文件", `可读写：\`${filePath}\``);
  } catch {
    try {
      await fs.access(directory, fsConstants.W_OK);
      return warn("状态文件", `文件未创建或不可直接访问，但目录可写：\`${directory}\``);
    } catch (error: unknown) {
      return fail("状态文件", `目录不可写：\`${directory}\`，${errorMessage(error)}`);
    }
  }
}

async function resolveCommand(command: string, pathEnv: string): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(command);
    return (await isExecutable(resolved)) ? resolved : undefined;
  }

  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }

  return undefined;
}

async function isExecutable(filePath: string) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function renderAgentConfig(args: string[]) {
  const model = extractCodexConfig(args, "model");
  const reasoning = extractCodexConfig(args, "model_reasoning_effort");
  const parts = [model ? `model=${model}` : undefined, reasoning ? `reasoning=${reasoning}` : undefined].filter(Boolean);
  return parts.length ? `，${parts.join("，")}` : "";
}

function extractCodexConfig(args: string[], key: string) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    const configValue = value === "-c" ? next : value?.startsWith("-c") ? value.slice(2).trim() : undefined;
    if (!configValue) continue;

    const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*['"]?([^'"]+)['"]?$`).exec(configValue);
    if (match) return match[1];
  }

  return undefined;
}

function ok(label: string, detail: string): DoctorItem {
  return { status: "ok", label, detail };
}

function warn(label: string, detail: string): DoctorItem {
  return { status: "warn", label, detail };
}

function fail(label: string, detail: string): DoctorItem {
  return { status: "fail", label, detail };
}

function statusLabel(status: DoctorItem["status"]) {
  switch (status) {
    case "ok":
      return "OK";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
  }
}

function maskValue(value: string) {
  if (!value) return "空";
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
