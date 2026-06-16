import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/StateStore.js";
import { AcpAgentClient } from "./AcpAgentClient.js";
import type { AcpAgentProvider, AgentPromptContent, AgentSession, AgentTurn } from "./types.js";

type ChatAgentState = {
  providerName: string;
  cwd: string;
  sessions: Map<string, AgentSession>;
};

export class AgentManager {
  private readonly providers = new Map<string, AcpAgentProvider>();
  private readonly clients = new Map<string, AcpAgentClient>();
  private readonly chats = new Map<string, ChatAgentState>();

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
    this.logger.info("switched chat cwd", { chatId, cwd });
  }

  async switchProvider(chatId: string, providerName: string) {
    const normalized = providerName.toLowerCase();
    const client = this.getClient(normalized);
    const state = this.getChatState(chatId);

    await client.start();
    state.providerName = normalized;
    state.sessions.delete(normalized);
    state.sessions.set(normalized, await client.newSession(state.cwd));
    this.stateStore.setChat(chatId, { providerName: normalized });

    this.logger.info("switched chat agent", { chatId, provider: normalized });
    return normalized;
  }

  async prompt(chatId: string, prompt: AgentPromptContent): Promise<AgentTurn> {
    const state = this.getChatState(chatId);
    const client = this.getClient(state.providerName);
    let session = state.sessions.get(state.providerName);

    if (!session || session.cwd !== state.cwd) {
      session = await client.newSession(state.cwd);
      state.sessions.set(state.providerName, session);
    }

    return client.prompt(session, prompt);
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
    if (session) {
      await this.getClient(state.providerName).cancelSession(session).catch((error: unknown) => {
        this.logger.warn("failed to cancel session during reset", error instanceof Error ? error.message : String(error));
      });
    }

    state.sessions.delete(state.providerName);
    this.logger.info("reset chat agent session", {
      chatId,
      provider: state.providerName,
      cwd: state.cwd,
      sessionId: session?.sessionId,
    });

    return Boolean(session);
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
