import assert from "node:assert/strict";
import { hasExplicitQqPromptText, summarizeQqBatch } from "../src/qq/qqPromptBatch.js";
import type { QqPromptItem } from "../src/qq/qqPromptBatch.js";

const imageOnly: QqPromptItem = {
  message: {
    eventType: "C2C_MESSAGE_CREATE",
    messageId: "msg-image",
    conversation: {
      type: "c2c",
      chatId: "qq:c2c:user-openid-1",
      openid: "user-openid-1",
    },
    senderIds: ["user-openid-1"],
    text: "",
    imageAttachments: [
      {
        contentType: "image/png",
        filename: "screen.png",
        url: "https://example.com/screen.png",
      },
    ],
    summary: "[图片]",
  },
};

const question: QqPromptItem = {
  message: {
    eventType: "C2C_MESSAGE_CREATE",
    messageId: "msg-text",
    conversation: {
      type: "c2c",
      chatId: "qq:c2c:user-openid-1",
      openid: "user-openid-1",
    },
    senderIds: ["user-openid-1"],
    text: "这个按钮为什么错位？",
    imageAttachments: [],
    summary: "这个按钮为什么错位？",
  },
};

assert.equal(hasExplicitQqPromptText(imageOnly.message), false);
assert.equal(hasExplicitQqPromptText(question.message), true);
assert.equal(summarizeQqBatch([imageOnly, question]), "[图片] / 这个按钮为什么错位？");

console.log("qq prompt batch tests passed");
