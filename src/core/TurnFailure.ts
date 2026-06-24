import { AgentPromptError } from "../acp/types.js";

export type TurnFailureContext = {
  turnId?: string;
  provider?: string;
  cwd?: string;
  text?: string;
};

export type TurnFailure = {
  turnId?: string;
  provider?: string;
  cwd?: string;
  sessionId?: string;
  message: string;
  text?: string;
  failedAt: number;
  timedOut?: boolean;
  timeoutMs?: number;
  cancelAfterTimeout?: string;
  cancelError?: string;
  recentStderr?: string[];
};

export function createTurnFailure(error: unknown, context: TurnFailureContext, failedAt = Date.now()): TurnFailure {
  if (error instanceof AgentPromptError) {
    return {
      turnId: error.details.turnId ?? context.turnId,
      provider: error.details.provider,
      cwd: error.details.cwd,
      sessionId: error.details.sessionId,
      message: error.message,
      text: context.text,
      failedAt,
      timedOut: error.details.timedOut,
      timeoutMs: error.details.timeoutMs,
      cancelAfterTimeout: error.details.cancelAfterTimeout,
      cancelError: error.details.cancelError,
      recentStderr: error.details.recentStderr,
    };
  }

  return {
    turnId: context.turnId,
    provider: context.provider,
    cwd: context.cwd,
    message: error instanceof Error ? error.message : String(error),
    text: context.text,
    failedAt,
  };
}

export function renderFailureSummary(failure: TurnFailure, now = Date.now()) {
  const ageSeconds = Math.max(0, Math.floor((now - failure.failedAt) / 1000));
  const age = ageSeconds >= 60 ? `${Math.floor(ageSeconds / 60)}m${(ageSeconds % 60).toString().padStart(2, "0")}s` : `${ageSeconds}s`;
  return [
    `最近失败：${failure.message}`,
    failure.turnId ? `失败 turn：${failure.turnId}` : undefined,
    failure.provider ? `失败 agent：${failure.provider}` : undefined,
    `距今：${age}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
