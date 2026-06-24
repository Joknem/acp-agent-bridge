import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CommandRouter, isSlashCommand, type SlashCommand } from "../core/CommandRouter.js";
import { IncomingMessagePipeline, type IncomingPipelineState } from "../core/IncomingMessagePipeline.js";
import { markdownToLarkCards, shouldUseLarkCard, type LarkCardContent } from "./larkCard.js";
import { markdownToLarkPost, type LarkPostContent } from "../markdown/larkPost.js";
import { parseIncomingFeishuMessage, type IncomingFeishuMessage } from "./incomingMessage.js";
import {
  hasExplicitPromptText,
  isDefaultImagePrompt,
  summarizeIncomingBatch,
  type FeishuPromptItem,
} from "./promptBatch.js";
import type { StateStore } from "../state/StateStore.js";
import { normalizeProjectName } from "../state/StateStore.js";
import { inferImageMimeType, readNodeStreamToBuffer } from "../utils/media.js";
import { truncate } from "../utils/text.js";
import type { AgentManager } from "../acp/AgentManager.js";
import { AgentPromptError } from "../acp/types.js";
import type { AgentPromptContent, AgentTurn } from "../acp/types.js";

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

type ReactionHandle = {
  messageId: string;
  reactionId: string;
  emojiType: string;
};

type AckState = {
  messageId: string;
  reaction?: ReactionHandle;
};

type PendingIncoming = FeishuPromptItem & {
  ackState?: AckState;
  chatType?: string;
};

type BindingTarget = {
  cwd: string;
  projectName?: string;
};

type ProcessTextOptions = {
  ackStates?: AckState[];
  chatType?: string;
};

type FeishuCommandContext = {
  chatId: string;
  chatType?: string;
};

type ChatState = IncomingPipelineState<PendingIncoming> & {
  activeTurn?: ActiveTurn;
  lastQueueNoticeAt?: number;
  lastBindNoticeAt?: number;
};

const QUEUE_NOTICE_COOLDOWN_MS = 30_000;
const BIND_NOTICE_COOLDOWN_MS = 30_000;

export class FeishuBot {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly commandRouter: CommandRouter<FeishuCommandContext>;
  private readonly incomingPipeline: IncomingMessagePipeline<PendingIncoming>;
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
    this.commandRouter = this.createCommandRouter();
    this.incomingPipeline = this.createIncomingPipeline();
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

  private createCommandRouter() {
    return new CommandRouter<FeishuCommandContext>()
      .register("help", async (_command, context) => this.handleHelpCommand(context.chatId))
      .register(["agent", "agents"], async (command, context) => this.handleAgentCommand(context.chatId, command))
      .register("cwd", async (command, context) => this.handleCwdCommand(context.chatId, command.raw, context.chatType))
      .register("project", async (command, context) => this.handleProjectCommand(context.chatId, command, context.chatType))
      .register("bind", async (command, context) => this.handleBindCommand(context.chatId, command, context.chatType))
      .register("unbind", async (_command, context) => this.handleUnbindCommand(context.chatId, context.chatType))
      .register("status", async (_command, context) => this.handleStatusCommand(context.chatId, context.chatType))
      .register("ping", async (_command, context) => this.handlePingCommand(context.chatId))
      .register("cancel", async (_command, context) => this.handleCancelCommand(context.chatId))
      .register("reset", async (_command, context) => this.handleResetCommand(context.chatId));
  }

  private createIncomingPipeline() {
    return new IncomingMessagePipeline<PendingIncoming>({
      mergeWindowMs: this.config.messageMergeWindowMs,
      summarize: summarizeIncomingBatch,
      onBatchQueued: (event) => {
        this.logger.info("queued feishu message batch", {
          chatId: event.chatId,
          messages: event.items.length,
          text: truncate(event.summary, 120),
        });
      },
      processBatch: async (event) => {
        const chatType = lastDefined(event.items.map((item) => item.chatType));
        await this.processIncomingBatch(event.chatId, event.items, {
          ackStates: event.items.flatMap((pending) => (pending.ackState ? [pending.ackState] : [])),
          chatType,
        });
      },
      onBatchError: async (error, event) => {
        this.logTurnError(event.chatId, error);
        await this.sendMarkdown(event.chatId, this.renderTurnError(error), "执行失败").catch(async (sendError: unknown) => {
          this.logger.error("failed to send error message", errorMessage(sendError));
          await this.sendText(event.chatId, `执行失败：${errorMessage(error)}`);
        });
      },
    });
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
    if (!this.stateStore.markProcessedMessage(`feishu:${message.message_id}`)) {
      this.logger.info("ignored duplicate feishu message", {
        messageId: message.message_id,
        chatId: message.chat_id,
      });
      return;
    }

    this.logger.info("received feishu message", {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: event.sender.sender_type,
      mentionCount: message.mentions?.length ?? 0,
    });

    const incoming = parseIncomingFeishuMessage({
      messageType: message.message_type,
      content: message.content,
      mentions: message.mentions,
    });

    if (!incoming) {
      this.logger.info("ignored unsupported feishu message", {
        messageId: message.message_id,
        messageType: message.message_type,
      });
      await this.sendMarkdown(message.chat_id, `暂只支持文本和图片消息，收到的是：\`${message.message_type}\``);
      return;
    }

    this.logger.info("parsed feishu message", {
      messageId: message.message_id,
      chatId: message.chat_id,
      kind: incoming.kind,
      text: truncate(incoming.summary, 120),
    });

    if (incoming.kind === "text" && !incoming.text) {
      await this.sendMarkdown(message.chat_id, "我收到了 @，但没有看到具体指令。可以直接发送问题，或发送 `/agent` 查看 agent。");
      return;
    }

    if (incoming.kind === "text" && isSlashCommand(incoming.text)) {
      await this.processIncoming(message.chat_id, message.message_id, incoming, { chatType: message.chat_type });
      return;
    }

    const provider = this.agentManager.currentProvider(message.chat_id);

    if (await this.maybeHandleUnboundGroupMessage(message.chat_id, message.chat_type)) {
      return;
    }

    const state = this.getChatState(message.chat_id);
    await this.maybeNotifyQueuedMessage(message.chat_id, incoming.summary, state);
    const ackState = await this.acknowledgeMergedIncoming(message.chat_id, message.message_id, provider, state);
    this.incomingPipeline.schedule(message.chat_id, state, {
      messageId: message.message_id,
      incoming,
      ackState,
      chatType: message.chat_type,
    });
  }

  private async acknowledgeMergedIncoming(
    chatId: string,
    messageId: string,
    provider: string,
    state: ChatState,
  ): Promise<AckState | undefined> {
    if (this.config.ackMode === "message" && state.pendingBatcher?.hasPending()) {
      return undefined;
    }

    return this.acknowledge(chatId, messageId, provider);
  }

  private async processIncoming(
    chatId: string,
    messageId: string,
    incoming: IncomingFeishuMessage,
    options: ProcessTextOptions = {},
  ) {
    const text = incoming.text;
    try {
      const handledCommand = await this.commandRouter.dispatch(
        text,
        { chatId, chatType: options.chatType },
        async (command, context) => this.handleUnknownCommand(context.chatId, command),
      );
      if (handledCommand) {
        return;
      }

      await this.processIncomingBatch(
        chatId,
        [{ messageId, incoming }],
        options,
      );
    } catch (error: unknown) {
      this.logTurnError(chatId, error);
      await this.sendMarkdown(chatId, this.renderTurnError(error), "执行失败").catch(async (sendError: unknown) => {
        this.logger.error("failed to send error message", errorMessage(sendError));
        await this.sendText(chatId, `执行失败：${errorMessage(error)}`);
      });
    }
  }

  private async processIncomingBatch(chatId: string, items: PendingIncoming[], options: ProcessTextOptions = {}) {
    if (!items.length) return;

    const summary = summarizeIncomingBatch(items);
    let ackStates = options.ackStates ?? [];
    if (await this.maybeHandleUnboundGroupMessage(chatId, options.chatType)) {
      await this.finishAcknowledgements(ackStates, "cancelled");
      return;
    }

    try {
      await this.applyGroupBinding(chatId, options.chatType);
    } catch (error: unknown) {
      await this.finishAcknowledgements(ackStates, "error");
      throw error;
    }

    const provider = this.agentManager.currentProvider(chatId);
    const cwd = this.agentManager.currentCwd(chatId);
    this.logger.info("prompting acp agent", {
      chatId,
      provider,
      cwd,
      messages: items.length,
      text: truncate(summary, 120),
    });

    const state = this.getChatState(chatId);
    const activeTurn: ActiveTurn = {
      messageId: items[0].messageId,
      provider,
      cwd,
      text: summary,
      startedAt: Date.now(),
    };
    state.activeTurn = activeTurn;

    try {
      if (!ackStates.length) {
        const ackState = await this.acknowledge(chatId, items[0].messageId, provider);
        ackStates = ackState ? [ackState] : [];
      }

      const prompt = await this.buildAgentPrompt(items);
      const turn = await this.agentManager.prompt(chatId, prompt);
      await this.sendTurn(chatId, turn);
      await this.finishAcknowledgements(ackStates, "success");
    } catch (error: unknown) {
      await this.finishAcknowledgements(ackStates, activeTurn.suppressError ? "cancelled" : "error");
      if (activeTurn.suppressError) {
        this.logger.info("suppressed cancelled turn error", {
          chatId,
          provider,
          message: errorMessage(error),
          text: truncate(summary, 120),
        });
        return;
      }

      throw error;
    } finally {
      if (state.activeTurn === activeTurn) {
        state.activeTurn = undefined;
      }
    }
  }

  private async handleAgentCommand(chatId: string, command: SlashCommand) {
    const rawAction = command.args[0];
    const rawName = command.args[1];
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

  private async handleCwdCommand(chatId: string, text: string, chatType?: string) {
    const rawTarget = text.replace(/^\/cwd(?:\s+)?/i, "").trim();

    if (!rawTarget) {
      const binding = this.stateStore.getBinding(chatId);
      await this.sendMarkdown(
        chatId,
        [
          `当前工作目录：\`${this.agentManager.currentCwd(chatId)}\``,
          isGroupChat(chatType) ? `群聊绑定：${binding ? `\`${binding.cwd}\`` : "`未绑定`"}` : undefined,
          "",
          isGroupChat(chatType) ? "切换并绑定：`/cwd /absolute/path` 或 `/bind /absolute/path`" : "切换：`/cwd /absolute/path`",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
        "工作目录",
      );
      return;
    }

    const target = path.resolve(rawTarget);
    await assertDirectory(target);
    const interrupted = await this.cancelActiveTurnForControl(chatId);
    this.agentManager.setCwd(chatId, target);
    if (isGroupChat(chatType)) {
      this.stateStore.setBinding(chatId, { cwd: target });
    }

    await this.sendMarkdown(
      chatId,
      [
        `${interrupted ? "已取消当前任务，并" : "已"}切换当前聊天的工作目录：\`${target}\``,
        isGroupChat(chatType) ? "这个群聊也已同步绑定到该目录。" : undefined,
        "",
        "该聊天下已有 agent session 已失效，下一条消息会用新目录创建 session。",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      "工作目录已切换",
    );
  }

  private async handleProjectCommand(chatId: string, command: SlashCommand, chatType?: string) {
    const action = command.args[0]?.toLowerCase();

    if (!action || action === "list") {
      await this.sendMarkdown(chatId, this.renderProjectList(), "项目别名");
      return;
    }

    if (action === "add") {
      const name = command.args[1];
      const rawCwd = command.args[2] ?? this.agentManager.currentCwd(chatId);
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
      const name = command.args[1];
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
    if (isGroupChat(chatType)) {
      this.stateStore.setBinding(chatId, { cwd, projectName: normalizeProjectName(action) });
    }
    await this.sendMarkdown(
      chatId,
      [
        `${interrupted ? "已取消当前任务，并" : "已"}切换到项目 \`${action}\`：\`${cwd}\``,
        isGroupChat(chatType) ? "这个群聊也已同步绑定到该项目。" : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      "项目已切换",
    );
  }

  private async handleBindCommand(chatId: string, command: SlashCommand, chatType?: string) {
    if (!isGroupChat(chatType)) {
      await this.sendMarkdown(chatId, ["私聊不需要绑定项目。", "", "私聊切换目录：`/cwd /absolute/path`", "保存常用目录：`/project add <name> [path]`"].join("\n"), "绑定项目");
      return;
    }

    const args = command.args;
    const target = args[0];
    if (!target || ["status", "current", "show"].includes(target.toLowerCase())) {
      await this.sendMarkdown(chatId, this.renderBindingStatus(chatId, chatType), "群聊绑定");
      return;
    }

    if (["new", "create"].includes(target.toLowerCase())) {
      await this.handleBindNewCommand(chatId, args);
      return;
    }

    const bindingTarget = await this.resolveBindingTarget(target);
    const interrupted = await this.cancelActiveTurnForControl(chatId);
    this.agentManager.setCwd(chatId, bindingTarget.cwd);
    this.stateStore.setBinding(chatId, bindingTarget);

    await this.sendMarkdown(
      chatId,
      [
        `${interrupted ? "已取消当前任务，并" : "已"}绑定这个群聊到：\`${bindingTarget.cwd}\``,
        bindingTarget.projectName ? `项目别名：\`${bindingTarget.projectName}\`` : undefined,
        "",
        "后续普通消息会直接发送给当前 agent，并使用这个目录作为 cwd。",
        "查看绑定：`/bind`",
        "解绑：`/unbind`",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      "群聊已绑定",
    );
  }

  private async handleBindNewCommand(chatId: string, args: string[]) {
    const rawName = args[1];
    const rawCwd = args[2];
    if (!rawName) {
      await this.sendMarkdown(chatId, "用法：`/bind new <project-name> [absolute-path]`", "创建并绑定项目");
      return;
    }

    const bindingTarget = await this.createBindingTarget(rawName, rawCwd);
    const interrupted = await this.cancelActiveTurnForControl(chatId);
    this.agentManager.setCwd(chatId, bindingTarget.cwd);
    this.stateStore.setProject(bindingTarget.projectName, bindingTarget.cwd);
    this.stateStore.setBinding(chatId, bindingTarget);

    await this.sendMarkdown(
      chatId,
      [
        `${interrupted ? "已取消当前任务，并" : "已"}创建并绑定这个群聊到：\`${bindingTarget.cwd}\``,
        `项目别名：\`${bindingTarget.projectName}\``,
        "",
        rawCwd ? "目录来自你指定的绝对路径。" : `目录默认创建在：\`${this.config.acp.cwd}\` 下。`,
        "后续普通消息会直接发送给当前 agent，并使用这个目录作为 cwd。",
        "查看绑定：`/bind`",
        "解绑：`/unbind`",
      ].join("\n"),
      "项目已创建并绑定",
    );
  }

  private async handleUnbindCommand(chatId: string, chatType?: string) {
    if (!isGroupChat(chatType)) {
      await this.sendMarkdown(chatId, "私聊不需要解绑。私聊可以用 `/cwd` 或 `/project <name>` 切换目录。", "解绑项目");
      return;
    }

    const interrupted = await this.cancelActiveTurnForControl(chatId);
    const removed = this.stateStore.deleteBinding(chatId);
    await this.sendMarkdown(
      chatId,
      [
        removed ? `${interrupted ? "已取消当前任务，并" : "已"}移除这个群聊的项目绑定。` : "这个群聊当前没有项目绑定。",
        "",
        "未绑定前，普通消息不会发送给 agent。",
        "重新绑定：`/bind /absolute/path` 或 `/bind <project-name>`",
        "创建新项目并绑定：`/bind new <name> [absolute-path]`",
      ].join("\n"),
      "群聊已解绑",
    );
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

  private async handleUnknownCommand(chatId: string, command: SlashCommand) {
    await this.sendMarkdown(chatId, `未知命令：\`${command.token}\`\n\n${this.renderHelp()}`, "未知命令");
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

  private async resolveBindingTarget(target: string): Promise<BindingTarget> {
    const projectName = normalizeProjectName(target);
    const projectCwd = this.stateStore.getProject(projectName);
    if (projectCwd) {
      await assertDirectory(projectCwd);
      return { cwd: projectCwd, projectName };
    }

    const cwd = path.resolve(target);
    await assertDirectory(cwd);
    return { cwd };
  }

  private async createBindingTarget(rawName: string, rawCwd?: string): Promise<Required<BindingTarget>> {
    const projectName = normalizeNewProjectName(rawName);
    const existingCwd = this.stateStore.getProject(projectName);

    if (existingCwd) {
      if (rawCwd) {
        const requestedCwd = resolveNewProjectCwd(this.config.acp.cwd, projectName, rawCwd);
        if (requestedCwd !== existingCwd) {
          throw new Error(`项目别名已存在：${projectName} -> ${existingCwd}`);
        }
      }

      await fs.mkdir(existingCwd, { recursive: true });
      await assertDirectory(existingCwd);
      return { cwd: existingCwd, projectName };
    }

    const cwd = resolveNewProjectCwd(this.config.acp.cwd, projectName, rawCwd);
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory(cwd);
    return { cwd, projectName };
  }

  private renderBindingStatus(chatId: string, chatType?: string) {
    if (!isGroupChat(chatType)) {
      return ["私聊不需要绑定项目。", "", "私聊切换目录：`/cwd /absolute/path`", "保存常用目录：`/project add <name> [path]`"].join("\n");
    }

    const binding = this.stateStore.getBinding(chatId);
    if (!binding) {
      return this.renderBindRequiredMessage();
    }

    return [
      "这个群聊已绑定项目目录。",
      "",
      `cwd：\`${binding.cwd}\``,
      binding.projectName ? `项目别名：\`${binding.projectName}\`` : undefined,
      "",
      "切换绑定：`/bind /absolute/path` 或 `/bind <project-name>`",
      "创建并绑定：`/bind new <name> [absolute-path]`",
      "移除绑定：`/unbind`",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private renderBindRequiredMessage() {
    const projects = this.stateStore.listProjects();
    const projectLines = projects.slice(0, 8).map((project) => `- \`${project.name}\`: \`${project.cwd}\``);
    const hasMore = projects.length > projectLines.length;

    return [
      "这个群聊还没有绑定项目目录。",
      "",
      "绑定目录：`/bind /absolute/path`",
      "绑定项目别名：`/bind <project-name>`",
      "创建新项目并绑定：`/bind new <name> [absolute-path]`",
      "查看项目别名：`/project`",
      "",
      projectLines.length ? "可用项目别名：" : undefined,
      ...projectLines,
      hasMore ? `还有 ${projects.length - projectLines.length} 个项目别名，可用 \`/project\` 查看全部。` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private async handleStatusCommand(chatId: string, chatType?: string) {
    await this.sendMarkdown(chatId, this.renderStatus(chatId, chatType), "当前配置");
  }

  private async handlePingCommand(chatId: string) {
    await this.sendText(chatId, "pong");
  }

  private renderStatus(chatId: string, chatType?: string) {
    const currentProvider = this.agentManager.currentProvider(chatId);
    const currentCwd = this.agentManager.currentCwd(chatId);
    const currentAgent = this.agentManager.listProviders().find((provider) => provider.name === currentProvider);
    const providerQueue = this.agentManager.providerQueueStatus(currentProvider);
    const projects = this.stateStore.listProjects();
    const bindings = this.stateStore.listBindings();
    const binding = this.stateStore.getBinding(chatId);
    const state = this.getChatState(chatId);
    const queueStatus = state.queue.status();
    const activeTurn = state.activeTurn;

    return [
      activeTurn ? `状态：\`处理中 ${formatDuration(Date.now() - activeTurn.startedAt)}\`` : "状态：`空闲`",
      activeTurn ? `正在处理：\`${truncate(activeTurn.text, 80)}\`` : undefined,
      state.pendingBatcher?.hasPending() ? `正在合并消息：\`${state.pendingBatcher.pendingCount()}\`` : undefined,
      `排队消息：\`${queueStatus.queued}\``,
      `当前 agent 全局队列：\`${providerQueue.active ? "处理中" : "空闲"}，等待 ${providerQueue.queued}\``,
      chatType ? `聊天类型：\`${chatType}\`` : undefined,
      isGroupChat(chatType) ? `群聊绑定：${binding ? "`已绑定`" : "`未绑定`"}` : undefined,
      binding ? `绑定 cwd：\`${binding.cwd}\`` : undefined,
      binding?.projectName ? `绑定项目：\`${binding.projectName}\`` : undefined,
      `当前 agent：\`${currentProvider}\``,
      `当前 cwd：\`${currentCwd}\``,
      currentAgent ? `agent 命令：\`${[currentAgent.command, ...currentAgent.args].join(" ")}\`` : undefined,
      `默认 agent：\`${this.config.acp.defaultAgent}\``,
      `ACP 超时：\`${this.config.acp.promptTimeoutMs}ms\``,
      `消息合并窗口：\`${this.config.messageMergeWindowMs}ms\``,
      `ACK 模式：\`${this.config.ackMode}\``,
      this.config.ackMode === "reaction" ? `处理中 reaction：\`${this.config.processingReaction}\`` : undefined,
      this.config.doneReaction ? `完成 reaction：\`${this.config.doneReaction}\`` : undefined,
      this.config.errorReaction ? `失败 reaction：\`${this.config.errorReaction}\`` : undefined,
      `发送超时：\`${this.config.sendTimeoutMs}ms\``,
      `debug：\`${this.config.debug}\``,
      `thinking/tool：\`${this.config.showThinkingTool}\``,
      `日志级别：\`${this.config.logLevel}\``,
      `状态文件：\`${this.config.stateFile}\``,
      `项目别名数：\`${projects.length}\``,
      `群聊绑定数：\`${bindings.length}\``,
      `消息去重缓存：\`${this.stateStore.processedMessageCount()}\``,
      "",
      "常用命令：",
      "- `/help`",
      "- `/agent`",
      "- `/cwd`",
      "- `/project`",
      "- `/bind`",
      "- `/unbind`",
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
      "- `/bind <path-or-project>` 绑定群聊项目",
      "- `/bind new <name> [absolute-path]` 创建新项目并绑定群聊",
      "- `/unbind` 移除群聊项目绑定",
      "- `/cancel` 取消当前任务",
      "- `/reset` 重置当前 agent session",
      "- `/ping` 测试飞书收发链路",
      "",
      "提示：控制命令会立即执行。普通消息会按当前聊天串行处理；未绑定群聊会先提示 `/bind`。",
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

  private async buildAgentPrompt(items: PendingIncoming[]): Promise<AgentPromptContent> {
    const prompt: AgentPromptContent = [];
    const imageItems = items.filter((item) => item.incoming.kind === "image");
    const hasExplicitText = items.some((item) => hasExplicitPromptText(item.incoming));

    if (!hasExplicitText && imageItems.length > 0) {
      prompt.push({
        type: "text",
        text: imageItems.length === 1 ? "请分析这张图片。" : `请分析这 ${imageItems.length} 张图片。`,
      });
    }

    for (const item of items) {
      const incoming = item.incoming;
      if (incoming.kind === "text") {
        prompt.push({ type: "text", text: incoming.text });
        continue;
      }

      if (!isDefaultImagePrompt(incoming)) {
        prompt.push({ type: "text", text: incoming.text });
      }

      prompt.push(await this.downloadMessageImage(item.messageId, incoming.imageKey));
    }

    return prompt;
  }

  private async downloadMessageImage(messageId: string, imageKey: string): Promise<AgentPromptContent[number]> {
    const resource = await this.withSendTimeout(
      this.client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: imageKey,
        },
        params: {
          type: "image",
        },
      }),
    );
    const buffer = await this.withSendTimeout(readNodeStreamToBuffer(resource.getReadableStream(), this.config.imageMaxBytes));
    const mimeType = inferImageMimeType(resource.headers?.["content-type"], buffer);

    this.logger.info("downloaded feishu image", {
      messageId,
      imageKey,
      bytes: buffer.byteLength,
      mimeType,
    });

    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
    };
  }

  private async sendMarkdown(chatId: string, markdown: string, title?: string) {
    if (shouldUseLarkCard(markdown)) {
      try {
        await this.sendInteractiveCards(chatId, markdownToLarkCards(markdown, title));
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

  private async sendInteractiveCards(chatId: string, cards: LarkCardContent[]) {
    for (const card of cards) {
      await this.sendInteractiveCard(chatId, card);
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

  private async acknowledge(chatId: string, messageId: string, provider: string): Promise<AckState | undefined> {
    switch (this.config.ackMode) {
      case "message":
        await this.sendMarkdown(chatId, `已收到，正在交给 \`${provider}\` 处理。`, "收到消息");
        return { messageId };
      case "reaction":
        return { messageId, reaction: await this.addReaction(messageId, this.config.processingReaction) };
      case "off":
        return undefined;
    }
  }

  private async finishAcknowledgement(ackState: AckState | undefined, status: "success" | "error" | "cancelled") {
    if (!ackState) return;

    if (ackState.reaction) {
      await this.removeReaction(ackState.reaction);
    }

    const finalReaction =
      status === "success" ? this.config.doneReaction : status === "error" ? this.config.errorReaction : undefined;
    if (finalReaction) {
      await this.addReaction(ackState.messageId, finalReaction);
    }
  }

  private async finishAcknowledgements(ackStates: AckState[], status: "success" | "error" | "cancelled") {
    await Promise.all(ackStates.map((ackState) => this.finishAcknowledgement(ackState, status)));
  }

  private async addReaction(messageId: string, emojiType: string): Promise<ReactionHandle | undefined> {
    if (!messageId || !emojiType) return undefined;

    try {
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
        this.logger.warn("failed to add reaction", { code: result.code, msg: result.msg, emojiType });
        return undefined;
      }

      const reactionId = result.data?.reaction_id;
      if (!reactionId) {
        this.logger.warn("reaction add response missing reaction_id", { messageId, emojiType });
        return undefined;
      }

      this.logger.info("added reaction", { messageId, reactionId, emojiType });
      return { messageId, reactionId, emojiType };
    } catch (error: unknown) {
      this.logger.warn("failed to add reaction", { messageId, emojiType, error: errorMessage(error) });
      return undefined;
    }
  }

  private async removeReaction(reaction: ReactionHandle) {
    try {
      const result = await this.withSendTimeout(
        this.client.im.messageReaction.delete({
          path: {
            message_id: reaction.messageId,
            reaction_id: reaction.reactionId,
          },
        }),
      );

      if (result.code && result.code !== 0) {
        this.logger.warn("failed to remove reaction", {
          code: result.code,
          msg: result.msg,
          messageId: reaction.messageId,
          reactionId: reaction.reactionId,
          emojiType: reaction.emojiType,
        });
        return;
      }

      this.logger.info("removed reaction", {
        messageId: reaction.messageId,
        reactionId: reaction.reactionId,
        emojiType: reaction.emojiType,
      });
    } catch (error: unknown) {
      this.logger.warn("failed to remove reaction", {
        messageId: reaction.messageId,
        reactionId: reaction.reactionId,
        emojiType: reaction.emojiType,
        error: errorMessage(error),
      });
    }
  }

  private getChatState(chatId: string) {
    let state = this.chats.get(chatId);
    if (!state) {
      state = this.incomingPipeline.createState();
      this.chats.set(chatId, state);
    }

    return state;
  }

  private async maybeHandleUnboundGroupMessage(chatId: string, chatType?: string) {
    if (!isGroupChat(chatType) || this.stateStore.getBinding(chatId)) return false;

    const state = this.getChatState(chatId);
    const now = Date.now();
    if (!state.lastBindNoticeAt || now - state.lastBindNoticeAt >= BIND_NOTICE_COOLDOWN_MS) {
      state.lastBindNoticeAt = now;
      await this.sendMarkdown(chatId, this.renderBindRequiredMessage(), "需要绑定项目");
    }

    return true;
  }

  private async applyGroupBinding(chatId: string, chatType?: string) {
    if (!isGroupChat(chatType)) return;

    const binding = this.stateStore.getBinding(chatId);
    if (!binding) return;

    await assertDirectory(binding.cwd);
    if (this.agentManager.currentCwd(chatId) !== binding.cwd) {
      this.agentManager.setCwd(chatId, binding.cwd);
    }
  }

  private async maybeNotifyQueuedMessage(chatId: string, text: string, state: ChatState) {
    if (!state.activeTurn && state.queue.status().queued === 0) return;

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

function lastDefined<T>(items: readonly (T | undefined)[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index] !== undefined) return items[index];
  }
  return undefined;
}

function permissionSuggestion(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("acp prompt timeout")) {
    return [
      "agent 在超时时间内没有结束，本次会话 session 已自动丢弃；下一条消息会创建新 session。",
      "可以先试：",
      "- 发 `/status` 看当前 agent、cwd 和队列",
      "- 发 `/agent kimi` 或 `/agent codex` 切换 agent",
      "- 把任务拆小一点再发",
      "- 如需更长等待时间，调整 `.env` 里的 `ACP_PROMPT_TIMEOUT_MS`",
    ].join("\n");
  }

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

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function isGroupChat(chatType?: string) {
  return chatType === "group";
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

function resolveNewProjectCwd(defaultRoot: string, projectName: string, rawCwd?: string) {
  if (!rawCwd) {
    return path.join(defaultRoot, projectName);
  }

  if (!path.isAbsolute(rawCwd)) {
    throw new Error(`新项目路径必须是绝对路径：${rawCwd}`);
  }

  return path.resolve(rawCwd);
}

function normalizeNewProjectName(name: string) {
  const normalized = normalizeProjectName(name);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error("项目名只能包含小写字母、数字、点、下划线和短横线，并且必须以字母或数字开头。");
  }

  return normalized;
}
