import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { resolveInsideRoot } from "../utils/pathSafety.js";
import { truncate } from "../utils/text.js";
import { AgentPromptError, type AcpAgentProvider, type AgentSession, type AgentTurn } from "./types.js";

type TurnBuffer = {
  answer: string[];
  thought: string[];
  tools: string[];
};

export class AcpAgentClient {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientSideConnection;
  private activeTurns = new Map<string, TurnBuffer>();
  private cancelledSessions = new Set<string>();
  private sessionCwds = new Map<string, string>();
  private stderrTail: string[] = [];
  private initPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly provider: AcpAgentProvider,
    private readonly logger: Logger,
  ) {}

  async start() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    return this.initPromise;
  }

  async newSession(cwd: string): Promise<AgentSession> {
    await this.start();
    const connection = this.requireConnection();
    const session = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    this.sessionCwds.set(session.sessionId, cwd);

    return { sessionId: session.sessionId, cwd };
  }

  async prompt(session: AgentSession, text: string): Promise<AgentTurn> {
    await this.start();
    const connection = this.requireConnection();
    const buffer: TurnBuffer = { answer: [], thought: [], tools: [] };
    this.activeTurns.set(session.sessionId, buffer);
    const startedAt = Date.now();

    try {
      this.logger.info("acp prompt started", {
        provider: this.provider.name,
        sessionId: session.sessionId,
        cwd: session.cwd,
        timeoutMs: this.config.acp.promptTimeoutMs,
        text: truncate(text, 120),
      });

      const response = await this.promptWithTimeout(connection, session, text);

      this.logger.info("acp prompt finished", {
        provider: this.provider.name,
        sessionId: session.sessionId,
        stopReason: response.stopReason,
        durationMs: Date.now() - startedAt,
        answerChars: buffer.answer.join("").length,
        thoughtChars: buffer.thought.join("").length,
        toolChars: buffer.tools.join("\n\n").length,
      });

      return {
        sessionId: session.sessionId,
        provider: this.provider.name,
        answerMarkdown: buffer.answer.join("").trim(),
        thoughtMarkdown: buffer.thought.join("").trim(),
        toolMarkdown: buffer.tools.join("\n\n").trim(),
        stopReason: response.stopReason,
      };
    } catch (error: unknown) {
      if (errorMessage(error).startsWith("ACP prompt timeout")) {
        await this.cancelSession(session).catch((cancelError: unknown) => {
          this.logger.warn("failed to cancel timed out acp prompt", errorMessage(cancelError));
        });
      }

      throw new AgentPromptError(errorMessage(error), {
        provider: this.provider.name,
        cwd: session.cwd,
        sessionId: session.sessionId,
        recentStderr: this.stderrTail,
      });
    } finally {
      this.activeTurns.delete(session.sessionId);
      this.cancelledSessions.delete(session.sessionId);
    }
  }

  private async promptWithTimeout(connection: acp.ClientSideConnection, session: AgentSession, text: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`ACP prompt timeout after ${this.config.acp.promptTimeoutMs}ms`));
          }, this.config.acp.promptTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancelSession(session: AgentSession) {
    await this.start();
    this.cancelledSessions.add(session.sessionId);
    await this.requireConnection().cancel({ sessionId: session.sessionId });
    this.activeTurns.delete(session.sessionId);
  }

  async stop() {
    this.process?.kill();
    this.process = undefined;
    this.connection = undefined;
    this.sessionCwds.clear();
    this.initPromise = undefined;
  }

  private async initialize() {
    await this.assertCwdExists();

    this.process = spawn(this.provider.command, this.provider.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.acp.cwd,
    });

    const agentProcess = this.process;
    const spawnError = new Promise<never>((_, reject) => {
      agentProcess.once("error", (error: NodeJS.ErrnoException) => {
        this.connection = undefined;
        this.process = undefined;
        this.initPromise = undefined;
        reject(new Error(this.formatSpawnError(error)));
      });
    });

    agentProcess.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8");
      this.recordStderr(message);
      this.logger.debug(`${this.provider.name} stderr`, { message });
    });

    agentProcess.on("exit", (code, signal) => {
      this.logger.warn("acp agent process exited", { provider: this.provider.name, code, signal });
      this.connection = undefined;
      this.initPromise = undefined;
    });

    const input = Writable.toWeb(agentProcess.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    this.connection = new acp.ClientSideConnection(() => this.clientHandler(), stream);

    const result = await Promise.race([
      this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      }),
      spawnError,
    ]);

    this.logger.info("connected to acp agent", {
      provider: this.provider.name,
      command: this.provider.command,
      args: this.provider.args,
      protocolVersion: result.protocolVersion,
      capabilities: result.agentCapabilities,
    });
  }

  private async assertCwdExists() {
    try {
      await fs.access(this.config.acp.cwd);
    } catch {
      throw new Error(
        `Default ACP cwd does not exist: ${this.config.acp.cwd}. Set ACP_DEFAULT_CWD in .env to an existing directory.`,
      );
    }
  }

  private recordStderr(message: string) {
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) this.stderrTail.push(truncate(trimmed, 1000));
    }

    if (this.stderrTail.length > 20) {
      this.stderrTail = this.stderrTail.slice(-20);
    }
  }

  private formatSpawnError(error: NodeJS.ErrnoException) {
    if (error.code === "ENOENT") {
      return [
        `Cannot start ACP agent "${this.provider.name}": executable not found: ${this.provider.command}`,
        `Set AGENT_${this.provider.name.toUpperCase()}_COMMAND in .env to an executable path or command in PATH.`,
        "On Linux/macOS, use `command -v <command>` to find an absolute path.",
      ].join("\n");
    }

    return `Cannot start ACP agent "${this.provider.name}": ${error.message}`;
  }

  private clientHandler(): acp.Client {
    return {
      requestPermission: async (params) => this.requestPermission(params),
      sessionUpdate: async (params) => this.sessionUpdate(params),
      readTextFile: async (params) => this.readTextFile(params),
      writeTextFile: async (params) => this.writeTextFile(params),
    };
  }

  private async requestPermission(params: RequestPermissionRequest) {
    this.appendTool(params.sessionId, `Permission requested: ${params.toolCall.title ?? "tool call"}`);
    if (this.cancelledSessions.has(params.sessionId)) {
      this.appendTool(params.sessionId, "Permission cancelled because the turn was cancelled");
      return { outcome: { outcome: "cancelled" as const } };
    }

    const option =
      params.options.find((item) => item.kind === "allow_once") ??
      params.options.find((item) => item.kind === "allow_always") ??
      params.options[0];

    if (!option) {
      return { outcome: { outcome: "cancelled" as const } };
    }

    this.appendTool(params.sessionId, `Permission selected: ${option.name}`);
    return {
      outcome: {
        outcome: "selected" as const,
        optionId: option.optionId,
      },
    };
  }

  private async sessionUpdate(params: SessionNotification) {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendAnswer(params.sessionId, contentToMarkdown(update.content));
        break;
      case "agent_thought_chunk":
        this.appendThought(params.sessionId, contentToMarkdown(update.content));
        break;
      case "tool_call":
        this.appendTool(
          params.sessionId,
          [`Tool: ${update.title}`, update.status ? `Status: ${update.status}` : undefined, toolContent(update.content)]
            .filter(Boolean)
            .join("\n"),
        );
        break;
      case "tool_call_update":
        this.appendTool(
          params.sessionId,
          [
            `Tool update: ${update.toolCallId}`,
            update.status ? `Status: ${update.status}` : undefined,
            toolContent(update.content ?? undefined),
          ]
            .filter(Boolean)
            .join("\n"),
        );
        break;
      case "plan":
        this.appendThought(params.sessionId, `Plan:\n${JSON.stringify(update.entries ?? update, null, 2)}`);
        break;
      default:
        this.logger.debug("ignored acp session update", { update: update.sessionUpdate });
    }
  }

  private async readTextFile(params: ReadTextFileRequest) {
    const safePath = resolveInsideRoot(this.getSessionCwd(params.sessionId), params.path);
    let content = await fs.readFile(safePath, "utf8");

    if (params.line && params.line > 1) {
      content = content.split(/\r?\n/).slice(params.line - 1).join("\n");
    }

    if (params.limit && params.limit > 0) {
      content = content.split(/\r?\n/).slice(0, params.limit).join("\n");
    }

    return { content };
  }

  private async writeTextFile(params: WriteTextFileRequest) {
    const safePath = resolveInsideRoot(this.getSessionCwd(params.sessionId), params.path);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, params.content, "utf8");
    return {};
  }

  private appendAnswer(sessionId: string, text: string) {
    this.activeTurns.get(sessionId)?.answer.push(text);
  }

  private appendThought(sessionId: string, text: string) {
    if (text.trim()) this.activeTurns.get(sessionId)?.thought.push(text);
  }

  private appendTool(sessionId: string, text: string) {
    if (text.trim()) this.activeTurns.get(sessionId)?.tools.push(truncate(text, 4000));
  }

  private requireConnection() {
    if (!this.connection) throw new Error(`ACP agent "${this.provider.name}" connection is not initialized`);
    return this.connection;
  }

  private getSessionCwd(sessionId: string) {
    return this.sessionCwds.get(sessionId) ?? this.config.acp.cwd;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function contentToMarkdown(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return `[image:${content.mimeType}]`;
    case "audio":
      return `[audio:${content.mimeType}]`;
    case "resource_link":
      return `[${content.name}](${content.uri})`;
    case "resource":
      return `[resource:${content.resource.uri}]`;
  }
}

function toolContent(content?: ToolCallContent[]) {
  if (!content?.length) return "";

  return content
    .map((item) => {
      switch (item.type) {
        case "content":
          return contentToMarkdown(item.content);
        case "diff":
          return `Diff: ${item.path}`;
        case "terminal":
          return `Terminal: ${item.terminalId}`;
      }
    })
    .join("\n");
}
