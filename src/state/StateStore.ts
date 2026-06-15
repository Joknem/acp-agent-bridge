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

const stateSchema = z.object({
  version: z.literal(1),
  chats: z.record(
    z.string(),
    z.object({
      providerName: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
    }),
  ),
  projects: z.record(z.string(), z.string().min(1)),
  bindings: z.record(z.string(), bindingSchema).default({}),
});

export type PersistedState = z.infer<typeof stateSchema>;

export class StateStore {
  private state: PersistedState = {
    version: 1,
    chats: {},
    projects: {},
    bindings: {},
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
    };
    void this.save();
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
}

export function normalizeProjectName(name: string) {
  return name.trim().toLowerCase();
}

function isNotFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
