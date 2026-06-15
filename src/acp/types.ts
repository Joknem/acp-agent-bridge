export type AgentTurn = {
  sessionId: string;
  provider: string;
  answerMarkdown: string;
  thoughtMarkdown: string;
  toolMarkdown: string;
  stopReason: string;
};

export type AgentSession = {
  sessionId: string;
  cwd: string;
};

export type AcpAgentProvider = {
  name: string;
  command: string;
  args: string[];
};

export class AgentPromptError extends Error {
  constructor(
    message: string,
    readonly details: {
      provider: string;
      cwd: string;
      sessionId: string;
      recentStderr: string[];
    },
  ) {
    super(message);
    this.name = "AgentPromptError";
  }
}
