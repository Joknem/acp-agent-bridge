import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/StateStore.js";
import { AsyncSerialQueue } from "../utils/AsyncSerialQueue.js";
import { AcpAgentClient } from "./AcpAgentClient.js";
import type { AcpAgentProvider, AgentPromptContent, AgentPromptOptions, AgentSession, AgentSessionInfo, AgentTurn } from "./types.js";

type ChatAgentState = {
  providerName: string;
  cwd: string;
  sessions: Map<string, AgentSession>;
};

export class AgentManager {
  private readonly providers = new Map<string, AcpAgentProvider>();
  private readonly clients = new Map<string, AcpAgentClient>();
  private readonly chats = new Map<string, ChatAgentState>();
  private readonly promptQueues = new Map<string, AsyncSerialQueue>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly stateStore: StateStore,
  ) {
    for (const provider of config.acp.agents) {
      this.providers.set(provider.name, provider);
    }
  }

  async startDefault() {
    await this.getClient(this.config.acp.defaultAgent).start();
  }

  async stopAll() {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
  }

  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      ...provider,
      isDefault: provider.name === this.config.acp.defaultAgent,
      isRunning: this.clients.has(provider.name),
    }));
  }

  currentProvider(chatId: string) {
    return this.getChatState(chatId).providerName;
  }

  currentCwd(chatId: string) {
    return this.getChatState(chatId).cwd;
  }

  setCwd(chatId: string, cwd: string) {
    const state = this.getChatState(chatId);
    state.cwd = cwd;
    state.sessions.clear();
    this.stateStore.setChat(chatId, { cwd });
    const clearedSessions = this.stateStore.clearChatSessions(chatId);
    this.logger.info("switched chat cwd", { chatId, cwd, clearedSessions });
  }

  async switchProvider(chatId: string, providerName: string) {
    const normalized = providerName.toLowerCase();
    const state = this.getChatState(chatId);
    const previousProvider = state.providerName;

    state.providerName = normalized;
    try {
      const session = await this.ensureSession(chatId, normalized);
      this.stateStore.setChat(chatId, { providerName: normalized });
      this.logger.info("switched chat agent", {
        chatId,
        provider: normalized,
        sessionId: session.sessionId,
        sessionSource: session.source,
      });

      return normalized;
    } catch (error: unknown) {
      state.providerName = previousProvider;
      throw error;
    }
  }

  async prompt(chatId: string, prompt: AgentPromptContent, options: AgentPromptOptions = {}): Promise<AgentTurn> {
    const state = this.getChatState(chatId);
    const providerName = state.providerName;

    return this.getPromptQueue(providerName).run(() => this.promptDirect(chatId, providerName, prompt, options), {
      id: options.turnId,
      kind: "agent_prompt",
      label: `${providerName} prompt`,
      summary: options.queueSummary ?? summarizePromptContent(prompt),
      owner: chatId,
    });
  }

  providerQueueStatus(providerName: string) {
    return this.getPromptQueue(providerName.toLowerCase()).status();
  }

  currentSessionInfo(chatId: string): AgentSessionInfo {
    const state = this.getChatState(chatId);
    const runtimeSession = state.sessions.get(state.providerName);
    const persistedSession = this.stateStore.getChatSession(chatId, state.providerName);

    return {
      providerName: state.providerName,
      cwd: state.cwd,
      sessionId: runtimeSession?.sessionId ?? persistedSession?.sessionId,
      source: runtimeSession?.source ?? (persistedSession ? "persisted" : undefined),
      persisted: Boolean(persistedSession),
      persistedCwd: persistedSession?.cwd,
      persistedUpdatedAt: persistedSession?.updatedAt,
      persistedResumedAt: persistedSession?.resumedAt,
    };
  }

  private async promptDirect(
    chatId: string,
    providerName: string,
    prompt: AgentPromptContent,
    options: AgentPromptOptions,
  ): Promise<AgentTurn> {
    const state = this.getChatState(chatId);
    const client = this.getClient(providerName);
    const session = await this.ensureSession(chatId, providerName);

    try {
      return await client.prompt(session, prompt, options);
    } catch (error: unknown) {
      state.sessions.delete(providerName);
      this.stateStore.deleteChatSession(chatId, providerName);
      this.logger.warn("cleared chat agent session after prompt failure", {
        turnId: options.turnId,
        chatId,
        provider: providerName,
        cwd: state.cwd,
        sessionId: session.sessionId,
        message: errorMessage(error),
      });
      throw error;
    }
  }

  async cancel(chatId: string) {
    const state = this.getChatState(chatId);
    const session = state.sessions.get(state.providerName);
    if (!session) return false;

    await this.getClient(state.providerName).cancelSession(session);
    return true;
  }

  async reset(chatId: string) {
    const state = this.getChatState(chatId);
    const session = state.sessions.get(state.providerName);
    const persisted = this.stateStore.getChatSession(chatId, state.providerName);
    if (session) {
      await this.getClient(state.providerName).cancelSession(session).catch((error: unknown) => {
        this.logger.warn("failed to cancel session during reset", error instanceof Error ? error.message : String(error));
      });
    }

    state.sessions.delete(state.providerName);
    this.stateStore.deleteChatSession(chatId, state.providerName);
    this.logger.info("reset chat agent session", {
      chatId,
      provider: state.providerName,
      cwd: state.cwd,
      sessionId: session?.sessionId ?? persisted?.sessionId,
      persisted: Boolean(persisted),
    });

    return Boolean(session || persisted);
  }

  clearSessionsForProvider(providerName: string) {
    const normalized = providerName.toLowerCase();
    for (const state of this.chats.values()) {
      state.sessions.delete(normalized);
    }
  }

  hasProvider(providerName: string) {
    return this.providers.has(providerName.toLowerCase());
  }

  private getClient(providerName: string) {
    const normalized = providerName.toLowerCase();
    const provider = this.providers.get(normalized);
    if (!provider) {
      throw new Error(`Unknown agent "${providerName}". Available: ${[...this.providers.keys()].join(", ")}`);
    }

    let client = this.clients.get(normalized);
    if (!client) {
      client = new AcpAgentClient(this.config, provider, this.logger);
      this.clients.set(normalized, client);
    }

    return client;
  }

  private getPromptQueue(providerName: string) {
    let queue = this.promptQueues.get(providerName);
    if (!queue) {
      queue = new AsyncSerialQueue();
      this.promptQueues.set(providerName, queue);
    }

    return queue;
  }

  private async ensureSession(chatId: string, providerName: string): Promise<AgentSession> {
    const state = this.getChatState(chatId);
    const runtimeSession = state.sessions.get(providerName);
    if (runtimeSession?.cwd === state.cwd) {
      return runtimeSession;
    }

    if (runtimeSession) {
      state.sessions.delete(providerName);
    }

    const client = this.getClient(providerName);
    const persistedSession = this.stateStore.getChatSession(chatId, providerName);
    if (persistedSession && persistedSession.cwd !== state.cwd) {
      this.stateStore.deleteChatSession(chatId, providerName);
    } else if (persistedSession) {
      try {
        const session = await client.resumeSession({
          sessionId: persistedSession.sessionId,
          cwd: persistedSession.cwd,
        });
        state.sessions.set(providerName, session);
        this.stateStore.setChatSession(chatId, providerName, {
          sessionId: session.sessionId,
          cwd: session.cwd,
          resumed: true,
        });
        this.logger.info("resumed persisted chat session", {
          chatId,
          provider: providerName,
          cwd: session.cwd,
          sessionId: session.sessionId,
          source: session.source,
        });
        return session;
      } catch (error: unknown) {
        this.stateStore.deleteChatSession(chatId, providerName);
        this.logger.warn("failed to resume persisted chat session, creating a new one", {
          chatId,
          provider: providerName,
          cwd: persistedSession.cwd,
          sessionId: persistedSession.sessionId,
          message: errorMessage(error),
        });
      }
    }

    const session = await client.newSession(state.cwd);
    state.sessions.set(providerName, session);
    this.stateStore.setChatSession(chatId, providerName, {
      sessionId: session.sessionId,
      cwd: session.cwd,
    });
    this.logger.info("created chat agent session", {
      chatId,
      provider: providerName,
      cwd: session.cwd,
      sessionId: session.sessionId,
    });
    return session;
  }

  private getChatState(chatId: string) {
    let state = this.chats.get(chatId);
    if (!state) {
      const persisted = this.stateStore.getChat(chatId);
      state = {
        providerName: this.resolvePersistedProvider(persisted?.providerName),
        cwd: persisted?.cwd ?? this.config.acp.cwd,
        sessions: new Map(),
      };
      this.chats.set(chatId, state);
    }

    return state;
  }

  private resolvePersistedProvider(providerName?: string) {
    if (providerName && this.providers.has(providerName)) {
      return providerName;
    }

    return this.config.acp.defaultAgent;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function summarizePromptContent(prompt: AgentPromptContent) {
  return prompt
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        const record = block as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "content";
        return typeof record.text === "string" && record.text.trim() ? record.text : `[${type}]`;
      }

      return String(block);
    })
    .join(" / ");
}
