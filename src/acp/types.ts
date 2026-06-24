import type { ContentBlock } from "@agentclientprotocol/sdk";

export type AgentPromptContent = ContentBlock[];

export type AgentTurn = {
  sessionId: string;
  provider: string;
  turnId?: string;
  answerMarkdown: string;
  thoughtMarkdown: string;
  toolMarkdown: string;
  stopReason: string;
};

export type AgentSession = {
  sessionId: string;
  cwd: string;
  source?: "new" | "resumed" | "loaded";
};

export type AcpAgentProvider = {
  name: string;
  command: string;
  args: string[];
};

export type AgentSessionInfo = {
  providerName: string;
  cwd: string;
  sessionId?: string;
  source?: AgentSession["source"] | "persisted";
  persisted: boolean;
  persistedCwd?: string;
  persistedUpdatedAt?: number;
  persistedResumedAt?: number;
};

export type AgentPromptOptions = {
  turnId?: string;
};

export class AgentPromptError extends Error {
  constructor(
    message: string,
    readonly details: {
      provider: string;
      cwd: string;
      sessionId: string;
      turnId?: string;
      recentStderr: string[];
    },
  ) {
    super(message);
    this.name = "AgentPromptError";
  }
}
