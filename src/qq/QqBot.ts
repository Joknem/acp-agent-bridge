import type { AgentManager } from "../acp/AgentManager.js";
import { AgentPromptError, type AgentPermissionContext, type AgentPromptContent, type AgentTurn } from "../acp/types.js";
import type { AppConfig } from "../config.js";
import {
  cancelledPermissionResponse,
  createPermissionRequestId,
  permissionResponseFromCommand,
  renderPermissionDecision,
  renderPermissionRequest,
  renderPermissionTimeout,
  type ChatPermissionView,
  type PermissionDecisionAction,
} from "../core/ChatPermission.js";
import { CommandRouter, isSlashCommand, type SlashCommand } from "../core/CommandRouter.js";
import {
  renderAgentList,
  renderAgentUsage,
  renderHelp,
  renderQueue,
  renderStatus,
  renderUnknownCommand,
} from "../core/CommandRenderers.js";
import { formatCommandForDisplay } from "../core/CommandRedaction.js";
import { parseDoctorScope, runDoctor, type DoctorChat, type DoctorItem } from "../core/Doctor.js";
import { IncomingMessagePipeline, type IncomingPipelineState } from "../core/IncomingMessagePipeline.js";
import { ReplyAdapter } from "../core/ReplyAdapter.js";
import { createTurnId } from "../core/TurnId.js";
import { createTurnFailure, type TurnFailure } from "../core/TurnFailure.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/StateStore.js";
import { inferImageMimeType, readWebStreamToBuffer } from "../utils/media.js";
import { truncate } from "../utils/text.js";
import { QqAccessTokenProvider } from "./QqAccessToken.js";
import { hasExplicitQqPromptText, summarizeQqBatch, type QqPromptItem } from "./qqPromptBatch.js";
import { parseQqIncomingEvent, splitQqText, type QqConversation, type QqIncomingMessage } from "./qqMessages.js";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";

type GatewayPayload = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
};

type ActiveTurn = {
  turnId: string;
  provider: string;
  cwd: string;
  startedAt: number;
  text: string;
  suppressError?: boolean;
};

type ChatState = IncomingPipelineState<QqPromptItem> & {
  activeTurn?: ActiveTurn;
  pendingPermission?: PendingChatPermission;
  lastFailure?: TurnFailure;
};

type QqCommandContext = {
  message: QqIncomingMessage;
  state: ChatState;
};

type QqReplyDestination = {
  conversation: QqConversation;
  replyToMessageId: string;
};

type PendingChatPermission = ChatPermissionView & {
  destination: QqReplyDestination;
  timer: NodeJS.Timeout;
  resolve: (response: RequestPermissionResponse) => void;
};

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export class QqBot {
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private sequence: number | null = null;
  private gatewaySessionId?: string;
  private stopped = false;
  private readonly chats = new Map<string, ChatState>();
  private readonly auth: QqAccessTokenProvider;
  private readonly commandRouter: CommandRouter<QqCommandContext>;
  private readonly incomingPipeline: IncomingMessagePipeline<QqPromptItem>;
  private readonly replies: ReplyAdapter<QqReplyDestination>;

  constructor(
    private readonly config: AppConfig,
    private readonly agentManager: AgentManager,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {
    this.auth = new QqAccessTokenProvider({
      appId: config.qq.appId,
      appSecret: config.qq.appSecret,
      legacyToken: config.qq.token,
    });
    this.replies = new ReplyAdapter<QqReplyDestination>({
      mode: "plain-text",
      sendPlainText: (destination, text) => this.sendText(destination.conversation, destination.replyToMessageId, text),
    });
    this.commandRouter = this.createCommandRouter();
    this.incomingPipeline = this.createIncomingPipeline();
  }

  async start() {
    if (!this.config.qq.enabled) return;
    this.stopped = false;
    await this.connect();
  }

  private createCommandRouter() {
    return new CommandRouter<QqCommandContext>()
      .register("help", async (_command, context) => this.handleHelpCommand(context.message))
      .register("status", async (_command, context) =>
        this.sendCommandReply(
          context.message,
          this.renderStatus(context.message.conversation.chatId, context.state, context.message.conversation.type),
          "当前配置",
          "status",
        ),
      )
      .register("queue", async (_command, context) => this.handleQueueCommand(context.message, context.state))
      .register(["approve", "allow"], async (command, context) =>
        this.handlePermissionDecisionCommand(context.message, context.state, command, "approve"),
      )
      .register(["deny", "reject"], async (command, context) =>
        this.handlePermissionDecisionCommand(context.message, context.state, command, "deny"),
      )
      .register("doctor", async (command, context) => this.handleDoctorCommand(context.message, context.state, command))
      .register("cancel", async (_command, context) => this.handleCancelCommand(context.message, context.state))
      .register("reset", async (_command, context) => this.handleResetCommand(context.message))
      .register(["agent", "agents"], async (command, context) => this.handleAgentCommand(context.message, command));
  }

  private createIncomingPipeline() {
    return new IncomingMessagePipeline<QqPromptItem>({
      mergeWindowMs: this.config.qq.messageMergeWindowMs,
      summarize: summarizeQqBatch,
      onBatchQueued: (event) => {
        this.logger.info("queued qq message batch", {
          chatId: event.chatId,
          messages: event.items.length,
          text: truncate(event.summary, 120),
        });
      },
      processBatch: async (event) => {
        await this.processMessageBatch(event.items, this.getChatState(event.chatId));
      },
    });
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const state of this.chats.values()) {
      this.incomingPipeline.stop(state);
    }
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    this.gatewaySessionId = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  private async connect() {
    const gatewayUrl = await this.fetchGatewayUrl();
    this.logger.info("connecting qq gateway", { url: gatewayUrl });
    this.ws = new WebSocket(gatewayUrl);

    this.ws.addEventListener("open", () => {
      this.logger.info("qq gateway websocket opened");
    });

    this.ws.addEventListener("message", (event) => {
      void this.handleGatewayMessage(event.data).catch((error: unknown) => {
        this.logger.error("failed to handle qq gateway message", errorMessage(error));
      });
    });

    this.ws.addEventListener("close", (event) => {
      this.logger.warn("qq gateway websocket closed", { code: event.code, reason: event.reason });
      this.gatewaySessionId = undefined;
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      this.logger.warn("qq gateway websocket error");
    });
  }

  private async fetchGatewayUrl() {
    const response = await fetch(`${this.config.qq.apiBase}/gateway`, {
      headers: await this.authHeaders(),
    });
    const body = (await response.json().catch(() => ({}))) as { url?: unknown; message?: unknown };
    if (!response.ok || typeof body.url !== "string") {
      throw new Error(`QQ gateway fetch failed: ${response.status} ${JSON.stringify(body)}`);
    }

    return body.url;
  }

  private async handleGatewayMessage(data: unknown) {
    const payload = parseGatewayPayload(data);
    if (!payload) return;
    if (typeof payload.s === "number") this.sequence = payload.s;

    switch (payload.op) {
      case OP_HELLO:
        await this.identify();
        this.startHeartbeat(payload.d);
        break;
      case OP_DISPATCH:
        await this.handleDispatch(payload);
        break;
      case OP_RECONNECT:
      case OP_INVALID_SESSION:
        this.logger.warn("qq gateway requested reconnect", { op: payload.op });
        this.reconnectNow();
        break;
      case OP_HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP_HEARTBEAT_ACK:
        this.logger.trace("qq heartbeat ack");
        break;
      default:
        this.logger.debug("ignored qq gateway opcode", { op: payload.op, t: payload.t });
    }
  }

  private async identify() {
    this.sendGatewayPayload({
      op: OP_IDENTIFY,
      d: {
        token: await this.auth.authorization(),
        intents: this.config.qq.intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "acp-agent-bridge",
          $device: "acp-agent-bridge",
        },
      },
    });
  }

  private startHeartbeat(data: unknown) {
    const heartbeatInterval = heartbeatIntervalMs(data);
    if (!heartbeatInterval) {
      this.logger.warn("qq hello missing heartbeat interval");
      return;
    }

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), heartbeatInterval);
    this.sendHeartbeat();
  }

  private sendHeartbeat() {
    this.sendGatewayPayload({
      op: OP_HEARTBEAT,
      d: this.sequence,
    });
  }

  private sendGatewayPayload(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("qq gateway websocket is not open");
      return;
    }

    this.ws.send(JSON.stringify(payload));
  }

  private async handleDispatch(payload: GatewayPayload) {
    if (payload.t === "READY") {
      const ready = payload.d && typeof payload.d === "object" ? (payload.d as Record<string, unknown>) : {};
      this.gatewaySessionId = typeof ready.session_id === "string" ? ready.session_id : undefined;
      this.logger.info("qq gateway ready", { sessionId: ready.session_id });
      return;
    }

    const message = parseQqIncomingEvent(payload.t, payload.d);
    if (!message) {
      this.logger.debug("ignored qq dispatch", { eventType: payload.t });
      return;
    }

    if (!this.stateStore.markProcessedMessage(`qq:${message.messageId}`)) {
      this.logger.info("ignored duplicate qq message", {
        eventType: message.eventType,
        chatId: message.conversation.chatId,
        messageId: message.messageId,
      });
      return;
    }

    this.logger.info("received qq message", {
      eventType: message.eventType,
      chatId: message.conversation.chatId,
      messageId: message.messageId,
      images: message.imageAttachments.length,
      text: truncate(message.summary, 120),
    });

    const state = this.getChatState(message.conversation.chatId);
    if (isImmediateCommand(message)) {
      await this.processImmediateMessage(message, state);
      return;
    }

    this.incomingPipeline.schedule(message.conversation.chatId, state, { message });
  }

  private async processImmediateMessage(message: QqIncomingMessage, state: ChatState) {
    this.incomingPipeline.flush(state);
    try {
      await this.processMessage(message, state);
    } catch (error: unknown) {
      this.logger.error("failed to handle qq command", {
        chatId: message.conversation.chatId,
        messageId: message.messageId,
        message: errorMessage(error),
      });
      await this.sendCommandReply(message, `错误：${errorMessage(error)}`, "执行失败", "error");
    }
  }

  private async processMessage(message: QqIncomingMessage, state: ChatState) {
    const handledCommand = await this.commandRouter.dispatch(
      message.text,
      { message, state },
      async (command, context) => this.handleUnknownCommand(context.message, command),
    );
    if (handledCommand) {
      return;
    }

    await this.processMessageBatch([{ message }], state);
  }

  private async processMessageBatch(items: QqPromptItem[], state: ChatState) {
    if (!items.length) return;

    const firstMessage = items[0].message;
    const chatId = firstMessage.conversation.chatId;
    const summary = summarizeQqBatch(items);
    const provider = this.agentManager.currentProvider(chatId);
    const cwd = this.agentManager.currentCwd(chatId);
    const turnId = createTurnId("qq");
    const activeTurn: ActiveTurn = {
      turnId,
      provider,
      cwd,
      startedAt: Date.now(),
      text: summary,
    };
    state.activeTurn = activeTurn;
    this.logger.info("prompting acp agent", {
      turnId,
      platform: "qq",
      chatId,
      provider,
      cwd,
      messages: items.length,
      text: truncate(summary, 120),
    });

    try {
      const prompt = await this.buildAgentPrompt(items);
      const turn = await this.agentManager.prompt(chatId, prompt, {
        turnId,
        queueSummary: summary,
        permissionHandler: (context) => this.requestChatPermission(replyDestination(firstMessage), state, context),
      });
      await this.sendTurn(firstMessage.conversation, firstMessage.messageId, turn);
    } catch (error: unknown) {
      if (activeTurn.suppressError) {
        this.logger.info("suppressed cancelled qq turn error", {
          chatId,
          turnId,
          provider,
          message: errorMessage(error),
          text: truncate(summary, 120),
        });
        return;
      }
      state.lastFailure = createTurnFailure(error, {
        turnId,
        provider,
        cwd,
        text: summary,
      });
      this.logTurnError(chatId, activeTurn, error);
      await this.replies.sendMarkdown(replyDestination(firstMessage), this.renderTurnError(error, activeTurn), "执行失败", "error");
    } finally {
      this.cancelPendingPermission(state);
      if (state.activeTurn === activeTurn) state.activeTurn = undefined;
    }
  }

  private async handleResetCommand(message: QqIncomingMessage) {
    const state = this.getChatState(message.conversation.chatId);
    if (state.activeTurn) state.activeTurn.suppressError = true;
    this.cancelPendingPermission(state);
    const reset = await this.agentManager.reset(message.conversation.chatId);
    await this.sendCommandReply(
      message,
      reset ? "已重置当前 QQ 会话的 agent session。" : "当前 QQ 会话还没有 agent session。",
      "重置会话",
    );
  }

  private async handleAgentCommand(message: QqIncomingMessage, command: SlashCommand) {
    const rawAction = command.args[0]?.toLowerCase();
    const rawName = rawAction === "switch" ? command.args[1] : command.args[0];
    if (rawAction === "switch" && !rawName) {
      await this.sendCommandReply(message, renderAgentUsage("plain"), "Agent 用法");
      return;
    }

    if (!rawName) {
      await this.sendCommandReply(message, this.renderAgentList(message.conversation.chatId), "Agent 列表");
      return;
    }

    if (!this.agentManager.hasProvider(rawName)) {
      await this.sendCommandReply(message, `未知 agent：${rawName}\n\n${this.renderAgentList(message.conversation.chatId)}`, "Agent 不存在");
      return;
    }

    const provider = await this.agentManager.switchProvider(message.conversation.chatId, rawName);
    await this.sendCommandReply(message, `已切换到 ${provider}。`, "Agent 已切换");
  }

  private async handleHelpCommand(message: QqIncomingMessage) {
    await this.sendCommandReply(message, this.renderHelp(), "帮助", "help");
  }

  private async handleQueueCommand(message: QqIncomingMessage, state: ChatState) {
    await this.sendCommandReply(message, this.renderQueue(message.conversation.chatId, state), "队列状态", "queue");
  }

  private async handlePermissionDecisionCommand(
    message: QqIncomingMessage,
    state: ChatState,
    command: SlashCommand,
    action: PermissionDecisionAction,
  ) {
    const pending = state.pendingPermission;
    if (!pending) {
      await this.sendCommandReply(message, "当前没有等待确认的权限请求。", "权限请求");
      return;
    }

    const result = permissionResponseFromCommand(pending.request, action, command.args[0]);
    if ("error" in result) {
      await this.sendCommandReply(
        message,
        [
          renderPermissionDecision(action, result, "plain"),
          "",
          "当前可选项：",
          ...pending.request.options.map((option, index) => `- ${index + 1}. ${option.name} ${option.kind}`),
        ].join("\n"),
        "权限选择无效",
      );
      return;
    }

    this.resolvePendingPermission(state, pending, result.response);
    await this.sendCommandReply(message, renderPermissionDecision(action, result, "plain"), action === "approve" ? "权限已批准" : "权限已拒绝");
  }

  private async handleCancelCommand(message: QqIncomingMessage, state: ChatState) {
    if (state.activeTurn) state.activeTurn.suppressError = true;
    const hadPendingPermission = this.cancelPendingPermission(state);
    const cancelled = await this.agentManager.cancel(message.conversation.chatId).catch((error: unknown) => {
      this.logger.warn("failed to cancel qq active turn", errorMessage(error));
      return false;
    });

    await this.sendCommandReply(
      message,
      state.activeTurn || hadPendingPermission || cancelled ? "已请求取消当前 agent 任务。" : "当前 QQ 会话没有正在使用的 agent session。",
      "取消任务",
    );
  }

  private async handleDoctorCommand(message: QqIncomingMessage, state: ChatState, command: SlashCommand) {
    const report = await runDoctor({
      config: this.config,
      providers: this.agentManager.listProviders(),
      state: this.doctorStateStats(),
      chat: this.doctorChat(message.conversation.chatId, message.conversation.type, state),
      platform: {
        qq: this.qqGatewayDoctorItems(),
      },
      scope: parseDoctorScope(command.args[0]),
    });

    await this.replies.sendDoctor(replyDestination(message), report);
  }

  private async handleUnknownCommand(message: QqIncomingMessage, command: SlashCommand) {
    await this.sendCommandReply(message, renderUnknownCommand(command.token, { mode: "plain", platform: "qq" }), "未知命令");
  }

  private renderStatus(chatId: string, state: ChatState, chatType: string) {
    const currentProvider = this.agentManager.currentProvider(chatId);
    const sessionInfo = this.agentManager.currentSessionInfo(chatId);
    const currentAgent = this.agentManager.listProviders().find((provider) => provider.name === currentProvider);
    const providerQueue = this.agentManager.providerQueueStatus(currentProvider);
    const queueStatus = state.queue.status();

    return renderStatus({
      mode: "plain",
      activeTurn: state.activeTurn,
      pendingPermission: state.pendingPermission
        ? {
            requestId: state.pendingPermission.requestId,
            toolTitle: state.pendingPermission.request.toolCall.title ?? state.pendingPermission.request.toolCall.toolCallId,
            expiresAt: state.pendingPermission.expiresAt,
          }
        : undefined,
      pendingBatchCount: state.pendingBatcher?.pendingCount() ?? 0,
      conversationQueue: { queued: queueStatus.queued },
      providerQueue: { active: Boolean(providerQueue.active), queued: providerQueue.queued },
      chatType,
      currentProvider,
      currentCwd: this.agentManager.currentCwd(chatId),
      session: sessionInfo,
      lastFailure: state.lastFailure,
      currentAgentCommand: currentAgent ? formatCommandForDisplay(currentAgent.command, currentAgent.args) : undefined,
      defaultAgent: this.config.acp.defaultAgent,
      acpTimeoutMs: this.config.acp.promptTimeoutMs,
      permissionMode: this.config.acp.permissionMode,
      messageMergeWindowMs: this.config.qq.messageMergeWindowMs,
      chatSessionCount: this.stateStore.chatSessionCount(),
      processedMessageCount: this.stateStore.processedMessageCount(),
      commands: ["/help", "/status", "/queue", "/approve", "/deny", "/doctor", "/agent", "/agent <name>", "/cancel", "/reset"],
    });
  }

  private renderQueue(chatId: string, state: ChatState) {
    const currentProvider = this.agentManager.currentProvider(chatId);
    return renderQueue({
      mode: "plain",
      visibleOwner: chatId,
      currentProvider,
      activeTurn: state.activeTurn,
      pendingBatchCount: state.pendingBatcher?.pendingCount() ?? 0,
      conversationQueue: state.queue.status(),
      providerQueues: this.agentManager.listProviders().map((provider) => ({
        provider: provider.name,
        queue: this.agentManager.providerQueueStatus(provider.name),
      })),
    });
  }

  private renderAgentList(chatId: string) {
    return renderAgentList({
      mode: "plain",
      currentProvider: this.agentManager.currentProvider(chatId),
      currentCwd: this.agentManager.currentCwd(chatId),
      providers: this.agentManager.listProviders(),
      shortcuts: [
        { label: "帮助", command: "/help" },
        { label: "切换 agent", command: "/agent <name>" },
        { label: "当前配置", command: "/status" },
        { label: "队列状态", command: "/queue" },
        { label: "自检", command: "/doctor" },
        { label: "重置会话", command: "/reset" },
      ],
    });
  }

  private renderHelp() {
    return renderHelp({ mode: "plain", platform: "qq" });
  }

  private async sendTurn(conversation: QqConversation, replyToMessageId: string, turn: AgentTurn) {
    await this.replies.sendAgent({ conversation, replyToMessageId }, turn);
  }

  private logTurnError(chatId: string, activeTurn: ActiveTurn, error: unknown) {
    if (error instanceof AgentPromptError) {
      this.logger.error("qq agent turn failed", {
        chatId,
        message: error.message,
        ...error.details,
        turnId: error.details.turnId ?? activeTurn.turnId,
      });
      return;
    }

    this.logger.error("qq agent turn failed", {
      chatId,
      turnId: activeTurn.turnId,
      provider: activeTurn.provider,
      cwd: activeTurn.cwd,
      message: errorMessage(error),
      text: truncate(activeTurn.text, 120),
    });
  }

  private renderTurnError(error: unknown, activeTurn: ActiveTurn) {
    if (error instanceof AgentPromptError) {
      const turnId = error.details.turnId ?? activeTurn.turnId;
      return [
        `错误：\`${error.message}\``,
        "",
        `turn：\`${turnId}\``,
        `agent：\`${error.details.provider}\``,
        `cwd：\`${error.details.cwd}\``,
        `session：\`${error.details.sessionId}\``,
        error.details.timedOut ? `timeout：\`${error.details.timeoutMs}ms\`` : undefined,
        error.details.cancelAfterTimeout ? `timeout cancel：\`${renderCancelStatus(error.details.cancelAfterTimeout)}\`` : undefined,
        error.details.cancelError ? `cancel error：\`${error.details.cancelError}\`` : undefined,
        renderRecentStderr(error.details.recentStderr),
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    }

    return [
      `错误：\`${errorMessage(error)}\``,
      "",
      `turn：\`${activeTurn.turnId}\``,
      `agent：\`${activeTurn.provider}\``,
      `cwd：\`${activeTurn.cwd}\``,
    ].join("\n");
  }

  private async buildAgentPrompt(items: QqPromptItem[]): Promise<AgentPromptContent> {
    const prompt: AgentPromptContent = [];
    const imageCount = items.reduce((sum, item) => sum + item.message.imageAttachments.length, 0);
    const hasExplicitText = items.some((item) => hasExplicitQqPromptText(item.message));

    if (!hasExplicitText && imageCount > 0) {
      prompt.push({
        type: "text",
        text: imageCount === 1 ? "请分析这张图片。" : `请分析这 ${imageCount} 张图片。`,
      });
    }

    for (const item of items) {
      const message = item.message;
      if (message.text) {
        prompt.push({ type: "text", text: message.text });
      }

      for (const attachment of message.imageAttachments) {
        prompt.push(await this.downloadImageAttachment(message.messageId, attachment));
      }
    }

    return prompt;
  }

  private async downloadImageAttachment(messageId: string, attachment: QqIncomingMessage["imageAttachments"][number]): Promise<AgentPromptContent[number]> {
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`不支持的 QQ 图片链接协议：${url.protocol}`);
    }

    const response = await fetch(url);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.config.qq.imageMaxBytes) {
      throw new Error(`图片过大：最大支持 ${this.config.qq.imageMaxBytes} bytes`);
    }

    if (!response.ok) {
      throw new Error(`QQ image download failed: ${response.status} ${await response.text().catch(() => "")}`);
    }

    const buffer = await readWebStreamToBuffer(response.body, this.config.qq.imageMaxBytes);
    const mimeType = inferImageMimeType(response.headers.get("content-type") || attachment.contentType, buffer);
    this.logger.info("downloaded qq image", {
      messageId,
      filename: attachment.filename,
      bytes: buffer.byteLength,
      mimeType,
    });

    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
    };
  }

  private async sendText(conversation: QqConversation, replyToMessageId: string, text: string) {
    const chunks = splitQqText(text, this.config.qq.replyMaxChars);
    for (const [index, chunk] of chunks.entries()) {
      await this.sendTextChunk(conversation, replyToMessageId, chunks.length > 1 ? `(${index + 1}/${chunks.length})\n${chunk}` : chunk, index + 1);
    }
  }

  private async sendCommandReply(
    message: QqIncomingMessage,
    markdown: string,
    title?: string,
    kind: "error" | "help" | "queue" | "status" | "plain" = "plain",
  ) {
    await this.replies.sendMarkdown(replyDestination(message), markdown, title, kind);
  }

  private async sendTextChunk(conversation: QqConversation, replyToMessageId: string, content: string, msgSeq: number) {
    const path =
      conversation.type === "group"
        ? `/v2/groups/${encodeURIComponent(conversation.groupOpenid)}/messages`
        : `/v2/users/${encodeURIComponent(conversation.openid)}/messages`;
    const response = await fetch(`${this.config.qq.apiBase}${path}`, {
      method: "POST",
      headers: {
        ...(await this.authHeaders()),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content,
        msg_type: 0,
        msg_id: replyToMessageId,
        msg_seq: msgSeq,
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`QQ send failed: ${response.status} ${body}`);
    }

    this.logger.info("sent qq message", {
      chatId: conversation.chatId,
      msgSeq,
      chars: content.length,
    });
  }

  private scheduleReconnect() {
    if (!this.config.qq.enabled || this.stopped || this.reconnectTimer) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        this.logger.error("qq reconnect failed", errorMessage(error));
        this.scheduleReconnect();
      });
    }, this.config.qq.reconnectMs);
  }

  private reconnectNow() {
    this.ws?.close();
    this.scheduleReconnect();
  }

  private getChatState(chatId: string) {
    let state = this.chats.get(chatId);
    if (!state) {
      state = this.incomingPipeline.createState();
      this.chats.set(chatId, state);
    }
    return state;
  }

  private requestChatPermission(
    destination: QqReplyDestination,
    state: ChatState,
    context: AgentPermissionContext,
  ): Promise<RequestPermissionResponse> {
    this.cancelPendingPermission(state);

    const requestId = createPermissionRequestId(context.turnId);
    const expiresAt = Date.now() + this.config.acp.permissionRequestTimeoutMs;

    return new Promise((resolve) => {
      const pending: PendingChatPermission = {
        requestId,
        provider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId,
        turnId: context.turnId,
        expiresAt,
        request: context.request,
        destination,
        resolve,
        timer: setTimeout(() => {
          if (state.pendingPermission !== pending) return;
          state.pendingPermission = undefined;
          resolve(cancelledPermissionResponse());
          void this.replies.sendMarkdown(destination, renderPermissionTimeout(pending, "plain"), "权限已超时").catch((error: unknown) => {
            this.logger.warn("failed to send qq permission timeout", {
              chatId: destination.conversation.chatId,
              message: errorMessage(error),
            });
          });
        }, this.config.acp.permissionRequestTimeoutMs),
      };

      state.pendingPermission = pending;
      void this.replies.sendMarkdown(destination, renderPermissionRequest(pending, "plain"), "ACP 权限请求").catch((error: unknown) => {
        if (state.pendingPermission !== pending) return;
        this.logger.warn("failed to send qq permission request", {
          chatId: destination.conversation.chatId,
          message: errorMessage(error),
        });
        this.resolvePendingPermission(state, pending, cancelledPermissionResponse());
      });
    });
  }

  private resolvePendingPermission(state: ChatState, pending: PendingChatPermission, response: RequestPermissionResponse) {
    if (state.pendingPermission !== pending) return false;

    clearTimeout(pending.timer);
    state.pendingPermission = undefined;
    pending.resolve(response);
    return true;
  }

  private cancelPendingPermission(state: ChatState) {
    const pending = state.pendingPermission;
    if (!pending) return false;
    return this.resolvePendingPermission(state, pending, cancelledPermissionResponse());
  }

  private async authHeaders() {
    return {
      authorization: await this.auth.authorization(),
    };
  }

  private doctorStateStats() {
    return {
      projects: this.stateStore.listProjects().length,
      bindings: this.stateStore.listBindings().length,
      chatSessions: this.stateStore.chatSessionCount(),
      processedMessages: this.stateStore.processedMessageCount(),
    };
  }

  private doctorChat(chatId: string, chatType: string, state: ChatState): DoctorChat {
    const sessionInfo = this.agentManager.currentSessionInfo(chatId);
    return {
      chatId,
      chatType,
      currentProvider: this.agentManager.currentProvider(chatId),
      currentCwd: this.agentManager.currentCwd(chatId),
      queued: state.queue.status().queued,
      pendingBatchCount: state.pendingBatcher?.pendingCount() ?? 0,
      activeTurnId: state.activeTurn?.turnId,
      activeText: state.activeTurn ? truncate(state.activeTurn.text, 120) : undefined,
      sessionId: sessionInfo.sessionId,
      sessionSource: sessionInfo.source,
      sessionPersisted: sessionInfo.persisted,
      lastFailure: state.lastFailure,
      binding: this.stateStore.getBinding(chatId),
    };
  }

  private qqGatewayDoctorItems(): DoctorItem[] {
    if (!this.config.qq.enabled) {
      return [{ status: "warn", label: "Gateway 实时状态", detail: "QQ adapter 未启用" }];
    }

    if (!this.ws) {
      return [{ status: "fail", label: "Gateway 实时状态", detail: "WebSocket 未创建" }];
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      return [{ status: "fail", label: "Gateway 实时状态", detail: websocketStateLabel(this.ws.readyState) }];
    }

    return [
      {
        status: "ok",
        label: "Gateway 实时状态",
        detail: this.gatewaySessionId ? `open，session ${this.gatewaySessionId}` : "open，等待 READY",
      },
    ];
  }
}

function parseGatewayPayload(data: unknown): GatewayPayload | undefined {
  try {
    const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const payload = parsed as Partial<GatewayPayload>;
    return typeof payload.op === "number" ? (payload as GatewayPayload) : undefined;
  } catch {
    return undefined;
  }
}

function heartbeatIntervalMs(data: unknown) {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).heartbeat_interval;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function renderCancelStatus(status: string) {
  switch (status) {
    case "succeeded":
      return "已自动取消";
    case "failed":
      return "自动取消失败";
    case "not_attempted":
      return "未尝试";
    default:
      return status;
  }
}

function renderRecentStderr(lines: string[] | undefined) {
  const recent = lines?.slice(-3) ?? [];
  if (!recent.length) return undefined;
  return ["最近 stderr：", ...recent.map((line) => `- \`${truncate(line, 160)}\``)].join("\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function websocketStateLabel(state: number) {
  switch (state) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return `unknown(${state})`;
  }
}

function isImmediateCommand(message: QqIncomingMessage) {
  return message.imageAttachments.length === 0 && isSlashCommand(message.text);
}

function replyDestination(message: QqIncomingMessage): QqReplyDestination {
  return {
    conversation: message.conversation,
    replyToMessageId: message.messageId,
  };
}
