import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../logger.js";

const bindingSchema = z.object({
  cwd: z.string().min(1),
  projectName: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const chatSessionSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  resumedAt: z.number().int().nonnegative().optional(),
});

const processedMessageSchema = z.object({
  seenAt: z.number().int().nonnegative(),
});

const chatSchema = z.object({
  providerName: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  sessions: z.record(z.string(), chatSessionSchema).default({}),
});

const stateSchema = z.object({
  version: z.literal(1),
  chats: z.record(z.string(), chatSchema),
  projects: z.record(z.string(), z.string().min(1)),
  bindings: z.record(z.string(), bindingSchema).default({}),
  processedMessages: z.record(z.string(), processedMessageSchema).default({}),
});

export type PersistedState = z.infer<typeof stateSchema>;
export type PersistedChatSession = z.infer<typeof chatSessionSchema>;

export class StateStore {
  private state: PersistedState = {
    version: 1,
    chats: {},
    projects: {},
    bindings: {},
    processedMessages: {},
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn("state file is invalid, starting with empty state", parsed.error.issues);
        return;
      }

      this.state = parsed.data;
      this.logger.info("state loaded", {
        filePath: this.filePath,
        chats: Object.keys(this.state.chats).length,
        projects: Object.keys(this.state.projects).length,
        bindings: Object.keys(this.state.bindings).length,
        processedMessages: Object.keys(this.state.processedMessages).length,
      });
    } catch (error: unknown) {
      if (isNotFound(error)) {
        this.logger.info("state file not found, starting with empty state", { filePath: this.filePath });
        return;
      }

      throw error;
    }
  }

  getChat(chatId: string) {
    return this.state.chats[chatId];
  }

  setChat(chatId: string, value: { providerName?: string; cwd?: string }) {
    this.state.chats[chatId] = {
      ...this.state.chats[chatId],
      ...value,
      sessions: this.state.chats[chatId]?.sessions ?? {},
    };
    void this.save();
  }

  getChatSession(chatId: string, providerName: string) {
    return this.state.chats[chatId]?.sessions[normalizeProviderName(providerName)];
  }

  setChatSession(chatId: string, providerName: string, value: { sessionId: string; cwd: string; resumed?: boolean }) {
    const now = Date.now();
    const chat = this.ensureChat(chatId);
    const normalizedProvider = normalizeProviderName(providerName);
    const previous = chat.sessions[normalizedProvider];
    chat.sessions[normalizedProvider] = {
      sessionId: value.sessionId,
      cwd: value.cwd,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      resumedAt: value.resumed ? now : previous?.resumedAt,
    };
    void this.save();
  }

  deleteChatSession(chatId: string, providerName: string) {
    const sessions = this.state.chats[chatId]?.sessions;
    if (!sessions) return false;

    const normalizedProvider = normalizeProviderName(providerName);
    const existed = normalizedProvider in sessions;
    delete sessions[normalizedProvider];
    if (existed) void this.save();
    return existed;
  }

  clearChatSessions(chatId: string) {
    const chat = this.state.chats[chatId];
    if (!chat) return 0;

    const count = Object.keys(chat.sessions).length;
    if (count > 0) {
      chat.sessions = {};
      void this.save();
    }
    return count;
  }

  chatSessionCount() {
    return Object.values(this.state.chats).reduce((sum, chat) => sum + Object.keys(chat.sessions).length, 0);
  }

  listProjects() {
    return Object.entries(this.state.projects)
      .map(([name, cwd]) => ({ name, cwd }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(name: string) {
    return this.state.projects[normalizeProjectName(name)];
  }

  setProject(name: string, cwd: string) {
    this.state.projects[normalizeProjectName(name)] = cwd;
    void this.save();
  }

  deleteProject(name: string) {
    const normalized = normalizeProjectName(name);
    const existed = normalized in this.state.projects;
    delete this.state.projects[normalized];
    if (existed) void this.save();
    return existed;
  }

  getBinding(chatId: string) {
    return this.state.bindings[chatId];
  }

  setBinding(chatId: string, value: { cwd: string; projectName?: string }) {
    const now = Date.now();
    const previous = this.state.bindings[chatId];
    this.state.bindings[chatId] = {
      cwd: value.cwd,
      projectName: value.projectName,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    void this.save();
  }

  deleteBinding(chatId: string) {
    const existed = chatId in this.state.bindings;
    delete this.state.bindings[chatId];
    if (existed) void this.save();
    return existed;
  }

  listBindings() {
    return Object.entries(this.state.bindings)
      .map(([chatId, binding]) => ({ chatId, ...binding }))
      .sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  markProcessedMessage(key: string, now = Date.now()) {
    this.pruneProcessedMessages(now);
    if (key in this.state.processedMessages) return false;

    this.state.processedMessages[key] = { seenAt: now };
    void this.save();
    return true;
  }

  processedMessageCount() {
    return Object.keys(this.state.processedMessages).length;
  }

  async flush() {
    await this.writeQueue;
  }

  private save() {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
        await fs.rename(tempPath, this.filePath);
      })
      .catch((error: unknown) => {
        this.logger.error("failed to save state", error instanceof Error ? error.message : String(error));
      });

    return this.writeQueue;
  }

  private pruneProcessedMessages(now: number) {
    let changed = false;
    const entries = Object.entries(this.state.processedMessages);
    const freshEntries = entries.filter(([, item]) => now - item.seenAt <= PROCESSED_MESSAGE_TTL_MS);
    if (freshEntries.length !== entries.length) changed = true;

    const sortedEntries = freshEntries.sort((a, b) => b[1].seenAt - a[1].seenAt);
    const retainedEntries = sortedEntries.slice(0, PROCESSED_MESSAGE_MAX_ENTRIES);
    if (retainedEntries.length !== freshEntries.length) changed = true;

    if (changed) {
      this.state.processedMessages = Object.fromEntries(retainedEntries);
      void this.save();
    }
  }

  private ensureChat(chatId: string): PersistedState["chats"][string] {
    const previous = this.state.chats[chatId];
    if (previous) return previous;

    const chat: PersistedState["chats"][string] = { sessions: {} };
    this.state.chats[chatId] = chat;
    return chat;
  }
}

export function normalizeProjectName(name: string) {
  return name.trim().toLowerCase();
}

function normalizeProviderName(name: string) {
  return name.trim().toLowerCase();
}

const PROCESSED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_MESSAGE_MAX_ENTRIES = 5000;

function isNotFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
