import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { markdownToLarkCard, shouldUseLarkCard, type LarkCardContent } from "./larkCard.js";
import { markdownToLarkPost, type LarkPostContent } from "../markdown/larkPost.js";
import type { StateStore } from "../state/StateStore.js";
import { normalizeProjectName } from "../state/StateStore.js";
import { extractJsonText, truncate } from "../utils/text.js";
import type { AgentManager } from "../acp/AgentManager.js";
import { AgentPromptError } from "../acp/types.js";
import type { AgentTurn } from "../acp/types.js";

type ReceiveMessageEvent = NonNullable<lark.EventHandles["im.message.receive_v1"]> extends (data: infer T) => unknown
  ? T
  : never;

type ActiveTurn = {
  messageId: string;
  provider: string;
  cwd: string;
  text: string;
  startedAt: number;
  suppressError?: boolean;
};

type ChatState = {
  queue: Promise<void>;
  queuedCount: number;
  activeTurn?: ActiveTurn;
  lastQueueNoticeAt?: number;
};

const QUEUE_NOTICE_COOLDOWN_MS = 30_000;

export class FeishuBot {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly chats = new Map<string, ChatState>();

  constructor(
    private readonly config: AppConfig,
    private readonly agentManager: AgentManager,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {
    const baseConfig = {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    };

    this.client = new lark.Client(baseConfig);
    this.wsClient = new lark.WSClient({
      ...baseConfig,
      loggerLevel: mapLogLevel(config.logLevel),
    });
  }

  start() {
    const dispatcher = new lark.EventDispatcher({ loggerLevel: mapLogLevel(this.config.logLevel) }).register({
      "im.message.receive_v1": (event) => {
        void this.handleMessage(event).catch((error: unknown) => {
          this.logger.error("failed to handle feishu message", errorMessage(error));
        });
      },
    });

    void this.checkCredentials();
    this.wsClient.start({ eventDispatcher: dispatcher });
    this.logger.info("feishu websocket bot started");
  }

  private async checkCredentials() {
    try {
      const result = await this.client.auth.tenantAccessToken.internal({
        data: {
          app_id: this.config.feishu.appId,
          app_secret: this.config.feishu.appSecret,
        },
      });

      if (result.code && result.code !== 0) {
        this.logger.error("feishu credential check failed", { code: result.code, msg: result.msg });
        return;
      }

      this.logger.info("feishu credential check passed", {
        appId: maskAppId(this.config.feishu.appId),
        domain: this.config.feishu.domain,
      });
    } catch (error: unknown) {
      this.logger.error("feishu credential check error", errorMessage(error));
    }
  }

  private async handleMessage(event: ReceiveMessageEvent) {
    const message = event.message;
    this.logger.info("received feishu message", {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: event.sender.sender_type,
      mentionCount: message.mentions?.length ?? 0,
    });

    if (message.message_type !== "text") {
      this.logger.info("ignored unsupported feishu message", {
        messageId: message.message_id,
        messageType: message.message_type,
      });
      await this.sendMarkdown(message.chat_id, `暂只支持文本消息，收到的是：\`${message.message_type}\``);
      return;
    }

    const text = stripMentionTokens(extractJsonText(message.content), message.mentions).trim();
    this.logger.info("parsed feishu text", {
      messageId: message.message_id,
      chatId: message.chat_id,
      text: truncate(text, 120),
    });

    if (!text) {
      await this.sendMarkdown(message.chat_id, "我收到了 @，但没有看到具体指令。可以直接发送问题，或发送 `/agent` 查看 agent。");
      return;
    }

    if (isImmediateCommand(text)) {
      await this.processText(message.chat_id, message.message_id, text);
      return;
    }

    const state = this.getChatState(message.chat_id);
    const queuedAcked = await this.maybeAcknowledgeQueuedMessage(message.chat_id, message.message_id, text, state);
    state.queuedCount += 1;
    state.queue = state.queue
      .catch(() => undefined)
      .then(async () => {
        state.queuedCount = Math.max(0, state.queuedCount - 1);
        await this.processText(message.chat_id, message.message_id, text, { skipAck: queuedAcked });
      });
  }

  private async processText(chatId: string, messageId: string, text: string, options: { skipAck?: boolean } = {}) {
    try {
      if (isHelpCommand(text)) {
        await this.handleHelpCommand(chatId);
        return;
      }

      if (isAgentCommand(text)) {
        await this.handleAgentCommand(chatId, text);
        return;
      }

      if (isCwdCommand(text)) {
        await this.handleCwdCommand(chatId, text);
        return;
      }

      if (isProjectCommand(text)) {
        await this.handleProjectCommand(chatId, text);
        return;
      }

      if (isStatusCommand(text)) {
        await this.handleStatusCommand(chatId);
        return;
      }

      if (isPingCommand(text)) {
        await this.handlePingCommand(chatId);
        return;
      }

      if (isCancelCommand(text)) {
        await this.handleCancelCommand(chatId);
        return;
      }

      if (isResetCommand(text)) {
        await this.handleResetCommand(chatId);
        return;
      }

      if (isSlashCommand(text)) {
        await this.sendMarkdown(chatId, `未知命令：\`${text.split(/\s+/)[0]}\`\n\n${this.renderHelp()}`, "未知命令");
        return;
      }

      const provider = this.agentManager.currentProvider(chatId);
      const cwd = this.agentManager.currentCwd(chatId);
      this.logger.info("prompting acp agent", { chatId, provider, cwd, text: truncate(text, 120) });

      const state = this.getChatState(chatId);
      const activeTurn: ActiveTurn = {
        messageId,
        provider,
        cwd,
        text,
        startedAt: Date.now(),
      };
      state.activeTurn = activeTurn;

      try {
        if (!options.skipAck) await this.acknowledge(chatId, messageId, provider);

        const turn = await this.agentManager.prompt(chatId, text);
        await this.sendTurn(chatId, turn);
      } catch (error: unknown) {
        if (activeTurn.suppressError) {
          this.logger.info("suppressed cancelled turn error", {
            chatId,
            provider,
            message: errorMessage(error),
            text: truncate(text, 120),
          });
          return;
        }

        throw error;
      } finally {
        if (state.activeTurn === activeTurn) {
          state.activeTurn = undefined;
        }
      }
    } catch (error: unknown) {
      this.logTurnError(chatId, error);
      await this.sendMarkdown(chatId, this.renderTurnError(error), "执行失败").catch(async (sendError: unknown) => {
        this.logger.error("failed to send error message", errorMessage(sendError));
        await this.sendText(chatId, `执行失败：${errorMessage(error)}`);
      });
    }
  }

  private async handleAgentCommand(chatId: string, text: string) {
    const [, rawAction, rawName] = text.match(/^\/agents?(?:\s+(\S+))?(?:\s+(\S+))?/i) ?? [];
    const action = rawAction?.toLowerCase();
    const name = rawName?.toLowerCase();

    if (!action || action === "list" || action === "current") {
      await this.sendMarkdown(chatId, this.renderAgentList(chatId), "Agent 列表");
      return;
    }

    const target = action === "switch" ? name : action;
    if (!target) {
      await this.sendMarkdown(chatId, "用法：`/agent <name>` 或 `/agent switch <name>`");
      return;
    }

    if (!this.agentManager.hasProvider(target)) {
      await this.sendMarkdown(chatId, `未知 agent：\`${target}\`\n\n${this.renderAgentList(chatId)}`, "Agent 不存在");
      return;
    }

    const interrupted = await this.cancelActiveTurnForControl(chatId);
    const provider = await this.agentManager.switchProvider(chatId, target);
    await this.sendMarkdown(
      chatId,
      `${interrupted ? "已取消当前任务，并" : "已"}切换到 \`${provider}\`。后续消息会发送给这个 agent。`,
      "Agent 已切换",
    );
  }

  private async handleCwdCommand(chatId: string, text: string) {
    const rawTarget = text.replace(/^\/cwd(?:\s+)?/i, "").trim();

    if (!rawTarget) {
      await this.sendMarkdown(chatId, `当前工作目录：\`${this.agentManager.currentCwd(chatId)}\`\n\n切换：\`/cwd /absolute/path\``, "工作目录");
      return;
    }

    const target = path.resolve(rawTarget);
    await assertDirectory(target);
    const interrupted = await this.cancelActiveTurnForControl(chatId);
    this.agentManager.setCwd(chatId, target);

    await this.sendMarkdown(
      chatId,
      [
        `${interrupted ? "已取消当前任务，并" : "已"}切换当前聊天的工作目录：\`${target}\``,
        "",
        "该聊天下已有 agent session 已失效，下一条消息会用新目录创建 session。",
      ].join("\n"),
      "工作目录已切换",
    );
  }

  private async handleProjectCommand(chatId: string, text: string) {
    const args = splitCommand(text.replace(/^\/project(?:\s+)?/i, ""));
    const action = args[0]?.toLowerCase();

    if (!action || action === "list") {
      await this.sendMarkdown(chatId, this.renderProjectList(), "项目别名");
      return;
    }

    if (action === "add") {
      const name = args[1];
      const rawCwd = args[2] ?? this.agentManager.currentCwd(chatId);
      if (!name) {
        await this.sendMarkdown(chatId, "用法：`/project add <name> [absolute-path]`");
        return;
      }

      const cwd = path.resolve(rawCwd);
      await assertDirectory(cwd);
      this.stateStore.setProject(name, cwd);
      await this.sendMarkdown(chatId, `已保存项目别名：\`${normalizeProjectName(name)}\` -> \`${cwd}\``, "项目别名已保存");
      return;
    }

    if (action === "remove" || action === "rm" || action === "delete") {
      const name = args[1];
      if (!name) {
        await this.sendMarkdown(chatId, "用法：`/project remove <name>`");
        return;
      }

      const removed = this.stateStore.deleteProject(name);
      await this.sendMarkdown(chatId, removed ? `已删除项目别名：\`${normalizeProjectName(name)}\`` : `项目别名不存在：\`${name}\``);
      return;
    }

    const cwd = this.stateStore.getProject(action);
    if (!cwd) {
      await this.sendMarkdown(chatId, `项目别名不存在：\`${action}\`\n\n${this.renderProjectList()}`, "项目别名不存在");
      return;
    }

    await assertDirectory(cwd);
    const interrupted = await this.cancelActiveTurnForControl(chatId);
    this.agentManager.setCwd(chatId, cwd);
    await this.sendMarkdown(chatId, `${interrupted ? "已取消当前任务，并" : "已"}切换到项目 \`${action}\`：\`${cwd}\``, "项目已切换");
  }

  private async handleCancelCommand(chatId: string) {
    const cancelled = await this.cancelActiveTurnForControl(chatId);
    await this.sendMarkdown(
      chatId,
      cancelled ? "已请求取消当前 agent 任务。" : "当前聊天没有正在使用的 agent session。",
      "取消任务",
    );
  }

  private async handleResetCommand(chatId: string) {
    this.markActiveTurnSuppressed(chatId);
    const reset = await this.agentManager.reset(chatId);
    await this.sendMarkdown(
      chatId,
      reset
        ? "已重置当前聊天的 agent session。下一条消息会创建新 session。"
        : "当前聊天还没有 agent session；下一条消息会自动创建。",
      "重置会话",
    );
  }

  private async handleHelpCommand(chatId: string) {
    await this.sendMarkdown(chatId, this.renderHelp(), "帮助");
  }

  private renderProjectList() {
    const projects = this.stateStore.listProjects();
    if (!projects.length) {
      return [
        "还没有项目别名。",
        "",
        "添加当前 cwd：`/project add acp`",
        "添加指定目录：`/project add acp /home/joknem/acp-create`",
        "使用别名：`/project acp`",
      ].join("\n");
    }

    return [
      "项目别名：",
      ...projects.map((project) => `- \`${project.name}\`: \`${project.cwd}\``),
      "",
      "使用：`/project <name>`",
      "添加：`/project add <name> [absolute-path]`",
      "删除：`/project remove <name>`",
    ].join("\n");
  }

  private async handleStatusCommand(chatId: string) {
    await this.sendMarkdown(chatId, this.renderStatus(chatId), "当前配置");
  }

  private async handlePingCommand(chatId: string) {
    await this.sendText(chatId, "pong");
  }

  private renderStatus(chatId: string) {
    const currentProvider = this.agentManager.currentProvider(chatId);
    const currentCwd = this.agentManager.currentCwd(chatId);
    const currentAgent = this.agentManager.listProviders().find((provider) => provider.name === currentProvider);
    const projects = this.stateStore.listProjects();
    const state = this.getChatState(chatId);
    const activeTurn = state.activeTurn;

    return [
      activeTurn ? `状态：\`处理中 ${formatDuration(Date.now() - activeTurn.startedAt)}\`` : "状态：`空闲`",
      activeTurn ? `正在处理：\`${truncate(activeTurn.text, 80)}\`` : undefined,
      `排队消息：\`${state.queuedCount}\``,
      `当前 agent：\`${currentProvider}\``,
      `当前 cwd：\`${currentCwd}\``,
      currentAgent ? `agent 命令：\`${[currentAgent.command, ...currentAgent.args].join(" ")}\`` : undefined,
      `默认 agent：\`${this.config.acp.defaultAgent}\``,
      `ACP 超时：\`${this.config.acp.promptTimeoutMs}ms\``,
      `ACK 模式：\`${this.config.ackMode}\``,
      this.config.ackMode === "reaction" ? `ACK reaction：\`${this.config.ackReaction}\`` : undefined,
      `发送超时：\`${this.config.sendTimeoutMs}ms\``,
      `debug：\`${this.config.debug}\``,
      `thinking/tool：\`${this.config.showThinkingTool}\``,
      `日志级别：\`${this.config.logLevel}\``,
      `状态文件：\`${this.config.stateFile}\``,
      `项目别名数：\`${projects.length}\``,
      "",
      "常用命令：",
      "- `/help`",
      "- `/agent`",
      "- `/cwd`",
      "- `/project`",
      "- `/status`",
      "- `/ping`",
      "- `/cancel`",
      "- `/reset`",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private renderHelp() {
    return [
      "常用命令：",
      "- `/help` 查看帮助",
      "- `/status` 查看当前聊天状态",
      "- `/agent` 查看可用 agent",
      "- `/agent codex` 切换到 Codex",
      "- `/agent kimi` 切换到 Kimi",
      "- `/cwd` 查看当前工作目录",
      "- `/cwd /absolute/path` 切换当前聊天工作目录",
      "- `/project` 查看项目别名",
      "- `/project add <name> [path]` 保存项目别名",
      "- `/project <name>` 切换到项目别名",
      "- `/cancel` 取消当前任务",
      "- `/reset` 重置当前 agent session",
      "- `/ping` 测试飞书收发链路",
      "",
      "提示：控制命令会立即执行。普通消息会按当前聊天串行处理；如果前面有任务，会先进入队列。",
    ].join("\n");
  }


  private renderAgentList(chatId: string) {
    const current = this.agentManager.currentProvider(chatId);
    const lines = this.agentManager.listProviders().map((provider) => {
      const marks = [
        provider.name === current ? "current" : undefined,
        provider.isDefault ? "default" : undefined,
        provider.isRunning ? "running" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      const suffix = marks ? ` (${marks})` : "";
      return `- \`${provider.name}\`${suffix}: \`${[provider.command, ...provider.args].join(" ")}\``;
    });

    return [
      `当前 agent：\`${current}\``,
      `当前 cwd：\`${this.agentManager.currentCwd(chatId)}\``,
      "",
      "可用 agent：",
      ...lines,
      "",
      "帮助：`/help`",
      "切换 agent：`/agent <name>`",
      "切换目录：`/cwd /absolute/path`",
      "项目别名：`/project`",
      "当前配置：`/status`",
      "发送测试：`/ping`",
      "取消任务：`/cancel`",
      "重置会话：`/reset`",
    ].join("\n");
  }

  private async sendTurn(chatId: string, turn: AgentTurn) {
    if (this.config.debug && this.config.showThinkingTool !== "force") {
      const debugMarkdown = buildDebugMarkdown(turn, this.config.showThinkingTool);
      if (debugMarkdown) {
        await this.sendMarkdown(chatId, debugMarkdown, "调试信息");
      }
    }

    const answer = turn.answerMarkdown || `(没有收到最终文本，停止原因：${turn.stopReason})`;
    await this.sendMarkdown(chatId, answer, `${turn.provider} 回复`);
  }

  private async sendMarkdown(chatId: string, markdown: string, title?: string) {
    if (shouldUseLarkCard(markdown)) {
      try {
        await this.sendInteractiveCard(chatId, markdownToLarkCard(markdown, title));
        return;
      } catch (error: unknown) {
        this.logger.warn("failed to send lark card, falling back to post", errorMessage(error));
      }
    }

    const content = markdownToLarkPost(markdown, title);
    try {
      await this.sendPost(chatId, content);
    } catch (error: unknown) {
      this.logger.warn("failed to send lark post, falling back to text", errorMessage(error));
      await this.sendText(chatId, `${title ? `${title}\n\n` : ""}${markdown}`);
    }
  }

  private async sendInteractiveCard(chatId: string, card: LarkCardContent) {
    const result = await this.withSendTimeout(
      this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      }),
    );

    if (result.code && result.code !== 0) {
      throw new Error(`Feishu card send failed: ${result.code} ${result.msg ?? ""}`.trim());
    }

    this.logger.info("sent feishu card", { chatId, title: card.header.title.content });
  }

  private async sendPost(chatId: string, post: LarkPostContent) {
    const result = await this.withSendTimeout(
      this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      }),
    );

    if (result.code && result.code !== 0) {
      throw new Error(`Feishu send failed: ${result.code} ${result.msg ?? ""}`.trim());
    }

    this.logger.info("sent feishu post", { chatId, title: post.zh_cn.title });
  }

  private async sendText(chatId: string, text: string) {
    const result = await this.withSendTimeout(
      this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      }),
    );

    if (result.code && result.code !== 0) {
      throw new Error(`Feishu text send failed: ${result.code} ${result.msg ?? ""}`.trim());
    }

    this.logger.info("sent feishu text", { chatId, text: truncate(text, 80) });
  }

  private async acknowledge(chatId: string, messageId: string, provider: string) {
    switch (this.config.ackMode) {
      case "message":
        await this.sendMarkdown(chatId, `已收到，正在交给 \`${provider}\` 处理。`, "收到消息");
        return;
      case "reaction":
        await this.addReaction(messageId, this.config.ackReaction);
        return;
      case "off":
        return;
    }
  }

  private async addReaction(messageId: string, emojiType: string) {
    const result = await this.withSendTimeout(
      this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      }),
    );

    if (result.code && result.code !== 0) {
      this.logger.warn("failed to add ack reaction", { code: result.code, msg: result.msg, emojiType });
      return;
    }

    this.logger.info("added ack reaction", { messageId, emojiType });
  }

  private getChatState(chatId: string) {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { queue: Promise.resolve(), queuedCount: 0 };
      this.chats.set(chatId, state);
    }

    return state;
  }

  private async maybeAcknowledgeQueuedMessage(chatId: string, messageId: string, text: string, state: ChatState) {
    if (!state.activeTurn && state.queuedCount === 0) return false;

    const provider = this.agentManager.currentProvider(chatId);
    await this.acknowledge(chatId, messageId, provider);

    const now = Date.now();
    if (!state.lastQueueNoticeAt || now - state.lastQueueNoticeAt >= QUEUE_NOTICE_COOLDOWN_MS) {
      state.lastQueueNoticeAt = now;
      const activeText = state.activeTurn ? `当前正在处理：\`${truncate(state.activeTurn.text, 80)}\`` : "前面还有消息正在排队。";
      await this.sendMarkdown(
        chatId,
        [`已加入队列：\`${truncate(text, 80)}\``, activeText, "", "可发送 `/cancel` 取消当前任务，或 `/status` 查看状态。"].join("\n"),
        "已加入队列",
      );
    }

    return true;
  }

  private markActiveTurnSuppressed(chatId: string) {
    const activeTurn = this.getChatState(chatId).activeTurn;
    if (activeTurn) activeTurn.suppressError = true;
    return Boolean(activeTurn);
  }

  private async cancelActiveTurnForControl(chatId: string) {
    const hadActiveTurn = this.markActiveTurnSuppressed(chatId);
    const cancelled = await this.agentManager.cancel(chatId).catch((error: unknown) => {
      this.logger.warn("failed to cancel active turn for control command", errorMessage(error));
      return false;
    });

    return hadActiveTurn || cancelled;
  }

  private logTurnError(chatId: string, error: unknown) {
    if (error instanceof AgentPromptError) {
      this.logger.error("agent turn failed", {
        chatId,
        message: error.message,
        ...error.details,
      });
      return;
    }

    this.logger.error("agent turn failed", errorMessage(error));
  }

  private renderTurnError(error: unknown) {
    if (error instanceof AgentPromptError) {
      const suggestion = permissionSuggestion(error.message);
      return [
        `执行失败：\`${error.message}\``,
        "",
        `agent：\`${error.details.provider}\``,
        `cwd：\`${error.details.cwd}\``,
        `session：\`${error.details.sessionId}\``,
        "",
        suggestion,
      ].join("\n");
    }

    return [`执行失败：\`${errorMessage(error)}\``, "", permissionSuggestion(errorMessage(error))].join("\n");
  }

  private async withSendTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Feishu send timeout after ${this.config.sendTimeoutMs}ms`)), this.config.sendTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function buildDebugMarkdown(turn: AgentTurn, mode: AppConfig["showThinkingTool"]) {
  const parts: string[] = [];

  if (turn.thoughtMarkdown) {
    parts.push(
      mode === "summary"
        ? `## Thinking\n${truncate(turn.thoughtMarkdown.replace(/\s+/g, " "), 500)}`
        : `## Thinking\n${turn.thoughtMarkdown}`,
    );
  }

  if (turn.toolMarkdown) {
    parts.push(
      mode === "summary"
        ? `## Tool Calls\n${truncate(turn.toolMarkdown.replace(/\s+/g, " "), 800)}`
        : `## Tool Calls\n${turn.toolMarkdown}`,
    );
  }

  return parts.join("\n\n");
}

function mapLogLevel(level: AppConfig["logLevel"]) {
  switch (level) {
    case "trace":
      return lark.LoggerLevel.trace;
    case "debug":
      return lark.LoggerLevel.debug;
    case "warn":
      return lark.LoggerLevel.warn;
    case "error":
      return lark.LoggerLevel.error;
    case "info":
    default:
      return lark.LoggerLevel.info;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function permissionSuggestion(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("outside current chat cwd")) {
    return [
      "这是工作目录边界限制，不是飞书授权问题。",
      "可以先试：",
      "- `/cwd` 查看当前目录",
      "- `/cwd /absolute/path` 切到目标项目根目录",
      "- `/project <name>` 切到已保存项目",
      "- `/reset` 重置当前 agent session",
    ].join("\n");
  }

  if (
    normalized.includes("eacces") ||
    normalized.includes("eperm") ||
    normalized.includes("permission denied") ||
    normalized.includes("operation not permitted")
  ) {
    return [
      "这是系统文件权限限制。服务以当前用户运行，不能越过 Linux 文件权限。",
      "可以先试：",
      "- 检查目标文件/目录是否属于当前用户",
      "- 用 `chmod`/`chown` 给当前用户授权",
      "- 避免让机器人直接执行需要 sudo 的操作",
      "- `/reset` 重置当前 agent session",
    ].join("\n");
  }

  if (normalized.includes("sandbox") || normalized.includes("approval") || normalized.includes("not allowed")) {
    return [
      "这可能是 Codex sandbox 或 approval 策略限制。",
      "可以先试：",
      "- `/status` 查看当前 agent 命令",
      "- 调整 `.env` 里的 `AGENT_CODEX_ARGS`",
      "- 对高风险操作，让 Codex 先给命令，你在终端手动执行",
      "- `/reset` 重置当前 agent session",
    ].join("\n");
  }

  return [
    "可以先试：",
    "- `/reset` 重置当前聊天的 agent session",
    "- `/agent` 查看并切换 agent",
    "- `/status` 查看当前配置",
  ].join("\n");
}

function isImmediateCommand(text: string) {
  return isSlashCommand(text);
}

function isSlashCommand(text: string) {
  return text.trim().startsWith("/");
}

function isHelpCommand(text: string) {
  return /^\/help(?:\s|$)/i.test(text.trim());
}

function isAgentCommand(text: string) {
  return /^\/agents?(?:\s|$)/i.test(text.trim());
}

function isCwdCommand(text: string) {
  return /^\/cwd(?:\s|$)/i.test(text.trim());
}

function isProjectCommand(text: string) {
  return /^\/project(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string) {
  return /^\/status(?:\s|$)/i.test(text.trim());
}

function isPingCommand(text: string) {
  return /^\/ping(?:\s|$)/i.test(text.trim());
}

function isCancelCommand(text: string) {
  return /^\/cancel(?:\s|$)/i.test(text.trim());
}

function isResetCommand(text: string) {
  return /^\/reset(?:\s|$)/i.test(text.trim());
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function stripMentionTokens(text: string, mentions: ReceiveMessageEvent["message"]["mentions"]) {
  let stripped = text;
  for (const mention of mentions ?? []) {
    stripped = stripped.replaceAll(mention.key, "");
    stripped = stripped.replaceAll(`@${mention.name}`, "");
  }

  return stripped;
}

function maskAppId(appId: string) {
  if (appId.length <= 8) return appId;
  return `${appId.slice(0, 7)}...${appId.slice(-4)}`;
}

async function assertDirectory(target: string) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`目录不存在：${target}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`不是目录：${target}`);
  }
}

function splitCommand(input: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}
