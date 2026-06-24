import type { AgentTurn } from "../acp/types.js";
import type { DoctorReport } from "./Doctor.js";
import {
  formatAgentReply,
  formatDoctorReply,
  formatErrorReply,
  formatMarkdownReply,
  formatReplyForPlainText,
  type FormattedReply,
  type ReplyKind,
} from "./ReplyFormatter.js";

export type ReplyDeliveryMode = "markdown" | "plain-text";

export type ReplyAdapterOptions<TDestination> = {
  mode: ReplyDeliveryMode;
  sendPlainText: (destination: TDestination, text: string) => Promise<void>;
  sendMarkdown?: (destination: TDestination, markdown: string, title?: string) => Promise<void>;
  onMarkdownSendError?: (error: unknown, reply: FormattedReply) => void;
};

export class ReplyAdapter<TDestination> {
  constructor(private readonly options: ReplyAdapterOptions<TDestination>) {}

  async send(destination: TDestination, reply: FormattedReply) {
    if (this.options.mode === "markdown" && this.options.sendMarkdown) {
      try {
        await this.options.sendMarkdown(destination, reply.markdown, reply.title);
        return;
      } catch (error: unknown) {
        this.options.onMarkdownSendError?.(error, reply);
      }
    }

    await this.options.sendPlainText(destination, formatReplyForPlainText(reply));
  }

  async sendAgent(destination: TDestination, turn: AgentTurn) {
    await this.send(destination, formatAgentReply(turn));
  }

  async sendDoctor(destination: TDestination, report: DoctorReport) {
    await this.send(destination, formatDoctorReply(report));
  }

  async sendError(destination: TDestination, message: string, title?: string) {
    await this.send(destination, formatErrorReply(message, title));
  }

  async sendMarkdown(destination: TDestination, markdown: string, title?: string, kind: ReplyKind = "plain") {
    await this.send(destination, formatMarkdownReply(markdown, title, kind));
  }
}
