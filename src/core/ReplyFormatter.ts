import type { AgentTurn } from "../acp/types.js";
import { formatDoctorReport, type DoctorReport } from "./Doctor.js";

export type ReplyKind = "agent" | "debug" | "doctor" | "error" | "help" | "status" | "plain";

export type FormattedReply = {
  kind: ReplyKind;
  markdown: string;
  plainText: string;
  title?: string;
};

export type PlainTextReplyOptions = {
  includeTitle?: boolean;
};

export function formatAgentReply(turn: AgentTurn): FormattedReply {
  const markdown = turn.answerMarkdown || `(没有收到最终文本，停止原因：${turn.stopReason})`;
  return formatMarkdownReply(markdown, `${turn.provider} 回复`, "agent");
}

export function formatDoctorReply(report: DoctorReport): FormattedReply {
  return formatMarkdownReply(formatDoctorReport(report), "Doctor", "doctor");
}

export function formatErrorReply(message: string, title = "执行失败"): FormattedReply {
  return formatMarkdownReply(message, title, "error");
}

export function formatMarkdownReply(markdown: string, title?: string, kind: ReplyKind = "plain"): FormattedReply {
  const normalized = normalizeMarkdown(markdown);
  return {
    kind,
    markdown: normalized,
    plainText: markdownToPlainText(normalized),
    title,
  };
}

export function formatReplyForPlainText(reply: FormattedReply, options: PlainTextReplyOptions = {}) {
  const includeTitle = options.includeTitle ?? true;
  const parts = includeTitle && reply.title ? [reply.title, reply.plainText] : [reply.plainText];
  return normalizePlainText(parts.filter(Boolean).join("\n\n"));
}

export function normalizeMarkdown(markdown: string) {
  const normalized = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || "(空回复)";
}

export function markdownToPlainText(markdown: string) {
  const lines: string[] = [];
  let inCodeFence = false;

  for (const rawLine of normalizeMarkdown(markdown).split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      lines.push(trimmed);
      continue;
    }

    if (inCodeFence) {
      lines.push(rawLine);
      continue;
    }

    lines.push(stripInlineMarkdown(rawLine));
  }

  return normalizePlainText(lines.join("\n"));
}

function stripInlineMarkdown(line: string) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string) => (alt ? `[图片: ${alt}]` : "[图片]"))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => `${label} (${url.trim()})`)
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1");
}

function normalizePlainText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
