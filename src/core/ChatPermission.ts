import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { truncate } from "../utils/text.js";
import type { CommandRenderMode } from "./CommandRenderers.js";

export type PermissionDecisionAction = "approve" | "deny";

export type ChatPermissionView = {
  requestId: string;
  provider: string;
  cwd: string;
  sessionId: string;
  turnId?: string;
  expiresAt: number;
  request: RequestPermissionRequest;
};

export type PermissionCommandResult =
  | {
      response: RequestPermissionResponse;
      option?: PermissionOption;
    }
  | {
      error: string;
    };

export function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export function permissionResponseFromCommand(
  request: RequestPermissionRequest,
  action: PermissionDecisionAction,
  rawChoice?: string,
): PermissionCommandResult {
  const explicitChoice = rawChoice?.trim();
  const option = explicitChoice
    ? findPermissionOption(request.options, explicitChoice)
    : defaultPermissionOption(request.options, action);

  if (!option) {
    if (action === "deny" && !explicitChoice) {
      return { response: cancelledPermissionResponse() };
    }

    return {
      error: explicitChoice
        ? `没有找到权限选项：${explicitChoice}`
        : `当前请求没有可用的${action === "approve" ? "批准" : "拒绝"}选项。`,
    };
  }

  if (action === "approve" && !option.kind.startsWith("allow_")) {
    return { error: `选项 ${option.name} 是拒绝类选项，请使用 /deny。` };
  }

  if (action === "deny" && !option.kind.startsWith("reject_")) {
    return { error: `选项 ${option.name} 是批准类选项，请使用 /approve。` };
  }

  return {
    option,
    response: {
      outcome: {
        outcome: "selected",
        optionId: option.optionId,
      },
    },
  };
}

export function renderPermissionRequest(view: ChatPermissionView, mode: CommandRenderMode) {
  const tool = view.request.toolCall;
  const rawInput = renderRawInput(tool.rawInput, mode);
  const locations = tool.locations?.slice(0, 6).map((location) => {
    const line = location.line ? `:${location.line}` : "";
    return `- ${code(`${location.path}${line}`, mode)}`;
  });

  return [
    "ACP agent 请求执行敏感操作，需要你确认。",
    "",
    `请求 ID：${code(view.requestId, mode)}`,
    view.turnId ? `turn：${code(view.turnId, mode)}` : undefined,
    `agent：${code(view.provider, mode)}`,
    `cwd：${code(view.cwd, mode)}`,
    `session：${code(view.sessionId, mode)}`,
    `工具：${code(tool.title ?? tool.toolCallId, mode)}`,
    tool.kind ? `类型：${code(tool.kind, mode)}` : undefined,
    rawInput ? `参数：${rawInput}` : undefined,
    locations?.length ? "涉及位置：" : undefined,
    ...(locations ?? []),
    "",
    "可选项：",
    ...view.request.options.map((option, index) => renderPermissionOption(option, index, mode)),
    "",
    `批准：${code("/approve", mode)} 或 ${code("/approve 2", mode)}`,
    `拒绝：${code("/deny", mode)} 或 ${code("/deny 3", mode)}`,
    `超时：${code(`${Math.max(0, view.expiresAt - Date.now())}ms`, mode)} 后自动取消。`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function renderPermissionDecision(action: PermissionDecisionAction, result: PermissionCommandResult, mode: CommandRenderMode) {
  if ("error" in result) return `权限选择无效：${result.error}`;
  if (result.response.outcome.outcome === "cancelled") return "已取消这次权限请求。";

  const verb = action === "approve" ? "已批准" : "已拒绝";
  return `${verb}：${code(result.option?.name ?? result.response.outcome.optionId, mode)}`;
}

export function renderPermissionTimeout(view: ChatPermissionView, mode: CommandRenderMode) {
  return [
    "权限请求已超时，已自动取消。",
    "",
    `请求 ID：${code(view.requestId, mode)}`,
    view.turnId ? `turn：${code(view.turnId, mode)}` : undefined,
    `工具：${code(view.request.toolCall.title ?? view.request.toolCall.toolCallId, mode)}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function createPermissionRequestId(turnId?: string) {
  return `${turnId ?? "permission"}-${Date.now().toString(36)}`;
}

function defaultPermissionOption(options: readonly PermissionOption[], action: PermissionDecisionAction) {
  if (action === "approve") {
    return findOptionByKind(options, "allow_once") ?? findOptionByKind(options, "allow_always");
  }

  return findOptionByKind(options, "reject_once") ?? findOptionByKind(options, "reject_always");
}

function findOptionByKind(options: readonly PermissionOption[], kind: PermissionOption["kind"]) {
  return options.find((option) => option.kind === kind);
}

function findPermissionOption(options: readonly PermissionOption[], rawChoice: string) {
  const index = Number(rawChoice);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1];
  }

  const normalized = rawChoice.toLowerCase();
  return options.find((option) => {
    return (
      option.optionId.toLowerCase() === normalized ||
      option.kind.toLowerCase() === normalized ||
      option.name.toLowerCase() === normalized
    );
  });
}

function renderPermissionOption(option: PermissionOption, index: number, mode: CommandRenderMode) {
  return `${index + 1}. ${code(option.name, mode)} ${code(option.kind, mode)} ${code(option.optionId, mode)}`;
}

function renderRawInput(value: unknown, mode: CommandRenderMode) {
  if (value === undefined || value === null) return undefined;

  try {
    return code(truncate(JSON.stringify(value), 300), mode);
  } catch {
    return code(truncate(String(value), 300), mode);
  }
}

function code(value: string, mode: CommandRenderMode) {
  if (mode === "plain") return value;
  return `\`${value.replace(/`/g, "\\`")}\``;
}
