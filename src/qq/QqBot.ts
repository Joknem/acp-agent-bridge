import type { AgentManager } from "../acp/AgentManager.js";
import type { AgentPromptContent, AgentTurn } from "../acp/types.js";
import type { AppConfig } from "../config.js";
import { CommandRouter, isSlashCommand, type SlashCommand } from "../core/CommandRouter.js";
import { ConversationQueue } from "../core/ConversationQueue.js";
import { MessageBatcher } from "../core/MessageBatcher.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/StateStore.js";
import { inferImageMimeType, readWebStreamToBuffer } from "../utils/media.js";
import { truncate } from "../utils/text.js";
import { QqAccessTokenProvider } from "./QqAccessToken.js";
import { hasExplicitQqPromptText, summarizeQqBatch, type QqPromptItem } from "./qqPromptBatch.js";
import { parseQqIncomingEvent, splitQqText, type QqConversation, type QqIncomingMessage } from "./qqMessages.js";

type GatewayPayload = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
};

type ActiveTurn = {
  startedAt: number;
  text: string;
};

type ChatState = {
  queue: ConversationQueue;
  activeTurn?: ActiveTurn;
  pendingBatcher?: MessageBatcher<QqPromptItem>;
};

type QqCommandContext = {
  message: QqIncomingMessage;
  state: ChatState;
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
  private stopped = false;
  private readonly chats = new Map<string, ChatState>();
  private readonly auth: QqAccessTokenProvider;
  private readonly commandRouter: CommandRouter<QqCommandContext>;

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
    this.commandRouter = this.createCommandRouter();
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
        this.sendText(context.message.conversation, context.message.messageId, this.renderStatus(context.message.conversation.chatId, context.state)),
      )
      .register("reset", async (_command, context) => this.handleResetCommand(context.message))
      .register(["agent", "agents"], async (command, context) => this.handleAgentCommand(context.message, command));
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const state of this.chats.values()) {
      state.pendingBatcher?.stop();
      state.pendingBatcher = undefined;
    }
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
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
      this.flushMessageBatch(message.conversation.chatId);
      this.enqueueMessage(message, state);
      return;
    }

    this.scheduleMessageBatch(message, state);
  }

  private enqueueMessage(message: QqIncomingMessage, state: ChatState) {
    state.queue.enqueue(async () => {
      await this.processMessage(message, state);
    });
  }

  private scheduleMessageBatch(message: QqIncomingMessage, state: ChatState) {
    state.pendingBatcher ??= new MessageBatcher(this.config.qq.messageMergeWindowMs, (items) => {
      this.enqueueMessageBatch(message.conversation.chatId, items);
    });
    state.pendingBatcher.add({ message });
  }

  private flushMessageBatch(chatId: string) {
    const state = this.getChatState(chatId);
    state.pendingBatcher?.flush();
  }

  private enqueueMessageBatch(chatId: string, items: QqPromptItem[]) {
    const state = this.getChatState(chatId);
    const summary = summarizeQqBatch(items);
    this.logger.info("queued qq message batch", {
      chatId,
      messages: items.length,
      text: truncate(summary, 120),
    });

    state.queue.enqueue(async () => {
      await this.processMessageBatch(items, state);
    });
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
    const activeTurn: ActiveTurn = {
      startedAt: Date.now(),
      text: summary,
    };
    state.activeTurn = activeTurn;

    try {
      const prompt = await this.buildAgentPrompt(items);
      const turn = await this.agentManager.prompt(chatId, prompt);
      await this.sendTurn(firstMessage.conversation, firstMessage.messageId, turn);
    } catch (error: unknown) {
      this.logger.error("qq agent turn failed", { chatId, message: errorMessage(error), text: truncate(summary, 120) });
      await this.sendText(firstMessage.conversation, firstMessage.messageId, `执行失败：${errorMessage(error)}`);
    } finally {
      if (state.activeTurn === activeTurn) state.activeTurn = undefined;
    }
  }

  private async handleResetCommand(message: QqIncomingMessage) {
    const reset = await this.agentManager.reset(message.conversation.chatId);
    await this.sendText(
      message.conversation,
      message.messageId,
      reset ? "已重置当前 QQ 会话的 agent session。" : "当前 QQ 会话还没有 agent session。",
    );
  }

  private async handleAgentCommand(message: QqIncomingMessage, command: SlashCommand) {
    const rawAction = command.args[0]?.toLowerCase();
    const rawName = rawAction === "switch" ? command.args[1] : command.args[0];
    if (!rawName) {
      await this.sendText(message.conversation, message.messageId, this.renderAgentList(message.conversation.chatId));
      return;
    }

    if (!this.agentManager.hasProvider(rawName)) {
      await this.sendText(message.conversation, message.messageId, `未知 agent：${rawName}\n\n${this.renderAgentList(message.conversation.chatId)}`);
      return;
    }

    const provider = await this.agentManager.switchProvider(message.conversation.chatId, rawName);
    await this.sendText(message.conversation, message.messageId, `已切换到 ${provider}。`);
  }

  private async handleHelpCommand(message: QqIncomingMessage) {
    await this.sendText(message.conversation, message.messageId, this.renderHelp());
  }

  private async handleUnknownCommand(message: QqIncomingMessage, command: SlashCommand) {
    await this.sendText(message.conversation, message.messageId, `未知命令：${command.token}\n\n${this.renderHelp()}`);
  }

  private renderStatus(chatId: string, state: ChatState) {
    const currentProvider = this.agentManager.currentProvider(chatId);
    const providerQueue = this.agentManager.providerQueueStatus(currentProvider);
    const queueStatus = state.queue.status();
    return [
      state.activeTurn ? `状态：处理中 ${formatDuration(Date.now() - state.activeTurn.startedAt)}` : "状态：空闲",
      state.activeTurn ? `正在处理：${truncate(state.activeTurn.text, 80)}` : undefined,
      state.pendingBatcher?.hasPending() ? `正在合并消息：${state.pendingBatcher.pendingCount()}` : undefined,
      `排队消息：${queueStatus.queued}`,
      `当前 agent：${currentProvider}`,
      `当前 agent 全局队列：${providerQueue.active ? "处理中" : "空闲"}，等待 ${providerQueue.queued}`,
      `当前 cwd：${this.agentManager.currentCwd(chatId)}`,
      `消息合并窗口：${this.config.qq.messageMergeWindowMs}ms`,
      `消息去重缓存：${this.stateStore.processedMessageCount()}`,
      "",
      "命令：/status /agent /agent <name> /reset",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private renderAgentList(chatId: string) {
    const current = this.agentManager.currentProvider(chatId);
    const lines = this.agentManager.listProviders().map((provider) => {
      const suffix = provider.name === current ? " (current)" : provider.isDefault ? " (default)" : "";
      return `- ${provider.name}${suffix}: ${[provider.command, ...provider.args].join(" ")}`;
    });
    return [`当前 agent：${current}`, "", "可用 agent：", ...lines].join("\n");
  }

  private renderHelp() {
    return ["命令：", "- /help", "- /status", "- /agent", "- /agent <name>", "- /agent switch <name>", "- /reset"].join("\n");
  }

  private async sendTurn(conversation: QqConversation, replyToMessageId: string, turn: AgentTurn) {
    const answer = turn.answerMarkdown || `(没有收到最终文本，停止原因：${turn.stopReason})`;
    await this.sendText(conversation, replyToMessageId, answer);
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
      state = {
        queue: new ConversationQueue(),
      };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private async authHeaders() {
    return {
      authorization: await this.auth.authorization(),
    };
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

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isImmediateCommand(message: QqIncomingMessage) {
  return message.imageAttachments.length === 0 && isSlashCommand(message.text);
}
