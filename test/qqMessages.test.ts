import assert from "node:assert/strict";
import { parseQqIncomingEvent, splitQqText } from "../src/qq/qqMessages.js";

const c2c = parseQqIncomingEvent("C2C_MESSAGE_CREATE", {
  id: "msg-c2c-1",
  content: "你好   bot",
  author: {
    user_openid: "user-openid-1",
  },
});

assert.equal(c2c?.eventType, "C2C_MESSAGE_CREATE");
assert.equal(c2c.messageId, "msg-c2c-1");
assert.equal(c2c.conversation.type, "c2c");
assert.equal(c2c.conversation.chatId, "qq:c2c:user-openid-1");
assert.deepEqual(c2c.senderIds, ["user-openid-1"]);
assert.equal(c2c.text, "你好 bot");
assert.equal(c2c.imageAttachments.length, 0);
assert.equal(c2c.summary, "你好 bot");

const group = parseQqIncomingEvent("GROUP_AT_MESSAGE_CREATE", {
  id: "msg-group-1",
  content: "<@!123456> 帮我看一下这个项目",
  group_openid: "group-openid-1",
  author: {
    member_openid: "member-openid-1",
  },
});

assert.equal(group?.eventType, "GROUP_AT_MESSAGE_CREATE");
assert.equal(group.messageId, "msg-group-1");
assert.equal(group.conversation.type, "group");
assert.equal(group.conversation.chatId, "qq:group:group-openid-1");
assert.deepEqual(group.senderIds, ["member-openid-1"]);
assert.equal(group.text, "帮我看一下这个项目");
assert.equal(group.summary, "帮我看一下这个项目");

const imageOnly = parseQqIncomingEvent("C2C_MESSAGE_CREATE", {
  id: "msg-c2c-image-1",
  content: "",
  author: {
    user_openid: "user-openid-1",
  },
  attachments: [
    {
      content_type: "image/png",
      filename: "screen.png",
      height: 720,
      width: 1280,
      size: 12345,
      url: "https://example.com/screen.png",
    },
    {
      content_type: "file",
      filename: "notes.txt",
      url: "https://example.com/notes.txt",
    },
  ],
});

assert.equal(imageOnly?.text, "");
assert.equal(imageOnly?.summary, "[图片]");
assert.equal(imageOnly.imageAttachments.length, 1);
assert.equal(imageOnly.imageAttachments[0].contentType, "image/png");
assert.equal(imageOnly.imageAttachments[0].url, "https://example.com/screen.png");

const imageWithText = parseQqIncomingEvent("GROUP_AT_MESSAGE_CREATE", {
  id: "msg-group-image-1",
  content: "<@123456> 这个 UI 怎么改",
  group_openid: "group-openid-1",
  attachments: [
    {
      content_type: "image/jpeg",
      filename: "ui.jpg",
      url: "https://example.com/ui.jpg",
    },
  ],
});

assert.equal(imageWithText?.text, "这个 UI 怎么改");
assert.equal(imageWithText?.summary, "这个 UI 怎么改 [图片]");
assert.equal(imageWithText?.imageAttachments.length, 1);

assert.equal(parseQqIncomingEvent("GROUP_AT_MESSAGE_CREATE", { id: "missing-group", content: "hi" }), undefined);

const chunks = splitQqText("第一段\n第二段很长很长\n第三段", 8);
assert(chunks.length > 1);
assert(chunks.every((chunk) => chunk.length <= 8 || !chunk.includes("\n")));

console.log("qq message tests passed");
