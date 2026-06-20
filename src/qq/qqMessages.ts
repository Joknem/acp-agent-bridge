export type QqConversation =
  | {
      type: "c2c";
      chatId: string;
      openid: string;
    }
  | {
      type: "group";
      chatId: string;
      groupOpenid: string;
    };

export type QqIncomingMessage = {
  eventType: "C2C_MESSAGE_CREATE" | "GROUP_AT_MESSAGE_CREATE";
  messageId: string;
  conversation: QqConversation;
  text: string;
  imageAttachments: QqImageAttachment[];
  summary: string;
};

export type QqImageAttachment = {
  contentType: string;
  filename: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
};

export function parseQqIncomingEvent(eventType: string | undefined, data: unknown): QqIncomingMessage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const messageId = stringField(record, "id");
  const text = normalizeQqContent(stringField(record, "content"));
  const imageAttachments = parseImageAttachments(record);
  if (!messageId || (!text && imageAttachments.length === 0)) return undefined;

  if (eventType === "C2C_MESSAGE_CREATE") {
    const author = objectField(record, "author");
    const openid = stringField(author, "user_openid");
    if (!openid) return undefined;
    return {
      eventType,
      messageId,
      conversation: {
        type: "c2c",
        chatId: `qq:c2c:${openid}`,
        openid,
      },
      text,
      imageAttachments,
      summary: summarizeQqMessage(text, imageAttachments.length),
    };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    const groupOpenid = stringField(record, "group_openid");
    if (!groupOpenid) return undefined;
    return {
      eventType,
      messageId,
      conversation: {
        type: "group",
        chatId: `qq:group:${groupOpenid}`,
        groupOpenid,
      },
      text,
      imageAttachments,
      summary: summarizeQqMessage(text, imageAttachments.length),
    };
  }

  return undefined;
}

function parseImageAttachments(record: Record<string, unknown>) {
  return arrayField(record, "attachments").flatMap((value): QqImageAttachment[] => {
    if (!value || typeof value !== "object") return [];
    const attachment = value as Record<string, unknown>;
    const contentType = stringField(attachment, "content_type").toLowerCase();
    const url = stringField(attachment, "url");
    if (!contentType.startsWith("image/") || !url) return [];

    return [
      {
        contentType,
        filename: stringField(attachment, "filename"),
        height: numberField(attachment, "height"),
        width: numberField(attachment, "width"),
        size: numberField(attachment, "size"),
        url,
      },
    ];
  });
}

function summarizeQqMessage(text: string, imageCount: number) {
  const imageSummary = imageCount ? `[图片${imageCount > 1 ? ` x${imageCount}` : ""}]` : "";
  return [text, imageSummary].filter(Boolean).join(" ") || imageSummary;
}

export function splitQqText(text: string, maxChars: number) {
  if (maxChars <= 0) return [text];
  const normalized = text.trim() || "(empty response)";
  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars / 2)) {
      cut = remaining.lastIndexOf("。", maxChars);
    }
    if (cut < Math.floor(maxChars / 2)) {
      cut = maxChars;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["(empty response)"];
}

function normalizeQqContent(content: string) {
  return content.replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim();
}

function objectField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrayField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
