import type { QqIncomingMessage } from "./qqMessages.js";

export type QqPromptItem = {
  message: QqIncomingMessage;
};

export function summarizeQqBatch(items: readonly QqPromptItem[]) {
  return items.map((item) => item.message.summary).join(" / ");
}

export function hasExplicitQqPromptText(message: QqIncomingMessage) {
  return Boolean(message.text.trim());
}
