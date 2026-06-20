import type { IncomingFeishuMessage } from "./incomingMessage.js";

export type FeishuPromptItem = {
  messageId: string;
  incoming: IncomingFeishuMessage;
};

export function summarizeIncomingBatch(items: readonly FeishuPromptItem[]) {
  return items.map((item) => item.incoming.summary).join(" / ");
}

export function hasExplicitPromptText(incoming: IncomingFeishuMessage) {
  return incoming.kind === "text" || !isDefaultImagePrompt(incoming);
}

export function isDefaultImagePrompt(incoming: IncomingFeishuMessage) {
  return incoming.kind === "image" && incoming.text === "请分析这张图片。" && incoming.summary === "[图片]";
}
