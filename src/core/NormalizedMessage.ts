export type NormalizedPlatform = "feishu" | "qq";

export type NormalizedChatType = "direct" | "group" | "channel" | "unknown";

export type NormalizedImage = {
  id?: string;
  url?: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
};

export type NormalizedMessage = {
  platform: NormalizedPlatform;
  messageId: string;
  chatId: string;
  chatType: NormalizedChatType;
  text: string;
  summary: string;
  images: NormalizedImage[];
  rawType?: string;
};

export function summarizeNormalizedMessages(messages: readonly NormalizedMessage[]) {
  return messages.map((message) => message.summary).join(" / ");
}

export function normalizedImageCount(messages: readonly NormalizedMessage[]) {
  return messages.reduce((count, message) => count + message.images.length, 0);
}

export function hasExplicitNormalizedText(message: NormalizedMessage) {
  return Boolean(message.text.trim());
}
