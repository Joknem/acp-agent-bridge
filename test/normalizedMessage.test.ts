import assert from "node:assert/strict";
import {
  hasExplicitNormalizedText,
  normalizedImageCount,
  summarizeNormalizedMessages,
  type NormalizedMessage,
} from "../src/core/NormalizedMessage.js";

const messages: NormalizedMessage[] = [
  {
    platform: "feishu",
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "direct",
    text: "",
    summary: "[图片]",
    images: [{ id: "img_v3_1", mimeType: "image/png" }],
    rawType: "image",
  },
  {
    platform: "qq",
    messageId: "msg_2",
    chatId: "qq:c2c:user",
    chatType: "direct",
    text: "这个 UI 怎么改？",
    summary: "这个 UI 怎么改？",
    images: [],
    rawType: "C2C_MESSAGE_CREATE",
  },
];

assert.equal(summarizeNormalizedMessages(messages), "[图片] / 这个 UI 怎么改？");
assert.equal(normalizedImageCount(messages), 1);
assert.equal(hasExplicitNormalizedText(messages[0]), false);
assert.equal(hasExplicitNormalizedText(messages[1]), true);

console.log("normalized message tests passed");
