import assert from "node:assert/strict";
import { parseIncomingFeishuMessage } from "../src/feishu/incomingMessage.js";

const text = parseIncomingFeishuMessage({
  messageType: "text",
  content: JSON.stringify({ text: "@_user_1 看一下这个问题" }),
  mentions: [{ key: "@_user_1", name: "bot" }],
});

assert.equal(text?.kind, "text");
assert.equal(text.text, "看一下这个问题");
assert.equal(text.summary, "看一下这个问题");

const image = parseIncomingFeishuMessage({
  messageType: "image",
  content: JSON.stringify({ image_key: "img_v3_abc" }),
});

assert.equal(image?.kind, "image");
assert.equal(image.imageKey, "img_v3_abc");
assert.equal(image.text, "请分析这张图片。");
assert.equal(image.summary, "[图片]");

const captionedImage = parseIncomingFeishuMessage({
  messageType: "image",
  content: JSON.stringify({ image_key: "img_v3_def", caption: "@_user_1 这个 UI 怎么改" }),
  mentions: [{ key: "@_user_1", name: "bot" }],
});

assert.equal(captionedImage?.kind, "image");
assert.equal(captionedImage.text, "这个 UI 怎么改");
assert.equal(captionedImage.summary, "这个 UI 怎么改 [图片]");

assert.equal(
  parseIncomingFeishuMessage({
    messageType: "file",
    content: JSON.stringify({ file_key: "file_v3_abc" }),
  }),
  undefined,
);

console.log("feishu incoming message tests passed");
