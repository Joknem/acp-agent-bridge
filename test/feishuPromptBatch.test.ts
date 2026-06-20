import assert from "node:assert/strict";
import {
  hasExplicitPromptText,
  isDefaultImagePrompt,
  summarizeIncomingBatch,
  type FeishuPromptItem,
} from "../src/feishu/promptBatch.js";

const imageOnly: FeishuPromptItem = {
  messageId: "om_image",
  incoming: {
    kind: "image",
    text: "请分析这张图片。",
    summary: "[图片]",
    imageKey: "img_v3_default",
  },
};

const question: FeishuPromptItem = {
  messageId: "om_text",
  incoming: {
    kind: "text",
    text: "这个按钮为什么错位？",
    summary: "这个按钮为什么错位？",
  },
};

const captionedImage: FeishuPromptItem = {
  messageId: "om_captioned",
  incoming: {
    kind: "image",
    text: "这个 UI 怎么改",
    summary: "这个 UI 怎么改 [图片]",
    imageKey: "img_v3_captioned",
  },
};

assert.equal(isDefaultImagePrompt(imageOnly.incoming), true);
assert.equal(hasExplicitPromptText(imageOnly.incoming), false);
assert.equal(hasExplicitPromptText(question.incoming), true);
assert.equal(hasExplicitPromptText(captionedImage.incoming), true);
assert.equal(summarizeIncomingBatch([imageOnly, question]), "[图片] / 这个按钮为什么错位？");

console.log("feishu prompt batch tests passed");
