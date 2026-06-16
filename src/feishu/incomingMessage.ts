import { extractJsonText } from "../utils/text.js";

export type FeishuMention = {
  key?: string;
  name?: string;
};

export type IncomingFeishuMessage =
  | {
      kind: "text";
      text: string;
      summary: string;
    }
  | {
      kind: "image";
      text: string;
      summary: string;
      imageKey: string;
    };

export function parseIncomingFeishuMessage(input: {
  messageType: string;
  content: string;
  mentions?: FeishuMention[];
}): IncomingFeishuMessage | undefined {
  if (input.messageType === "text") {
    const text = stripMentionTokens(extractJsonText(input.content), input.mentions).trim();
    return {
      kind: "text",
      text,
      summary: text,
    };
  }

  if (input.messageType === "image") {
    const parsed = parseJsonObject(input.content);
    const imageKey = stringField(parsed, "image_key");
    if (!imageKey) return undefined;

    const caption = stripMentionTokens(stringField(parsed, "text") || stringField(parsed, "caption") || "", input.mentions).trim();
    const text = caption || "请分析这张图片。";
    return {
      kind: "image",
      text,
      summary: caption ? `${caption} [图片]` : "[图片]",
      imageKey,
    };
  }

  return undefined;
}

function stripMentionTokens(text: string, mentions: FeishuMention[] | undefined) {
  let stripped = text;
  for (const mention of mentions ?? []) {
    if (mention.key) stripped = stripped.replaceAll(mention.key, "");
    if (mention.name) stripped = stripped.replaceAll(`@${mention.name}`, "");
  }

  return stripped;
}

function parseJsonObject(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function stringField(value: object, key: string) {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}
