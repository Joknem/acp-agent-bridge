import assert from "node:assert/strict";
import { markdownToLarkCard, shouldUseLarkCard } from "../src/feishu/larkCard.js";
import { markdownToLarkPost } from "../src/markdown/larkPost.js";

const post = markdownToLarkPost(`# 标题

这是一段 **粗体**、*斜体*、\`code\`、[链接](https://example.com) 和 [相对链接](README.md)。

- 一级
  - 二级
1. 第一
2. 第二

| 名称 | 值 |
| --- | --- |
| A | 1 |

\`\`\`ts
const x = 1;
\`\`\`
`);

assert.equal(post.zh_cn.title, "标题");

const flat = post.zh_cn.content.flat();
assert(flat.some((item) => item.tag === "text" && item.text.includes("粗体") && item.style?.includes("bold")));
assert(flat.some((item) => item.tag === "text" && item.text.includes("斜体") && item.style?.includes("italic")));
assert(flat.some((item) => item.tag === "text" && item.text.includes("code") && item.style?.includes("code")));
assert(flat.some((item) => item.tag === "a" && item.href === "https://example.com"));
assert(!flat.some((item) => item.tag === "a" && item.href === "README.md"));
assert(flat.some((item) => item.tag === "text" && item.text.includes("相对链接 (README.md)")));
assert(flat.some((item) => item.tag === "code_block" && item.language === "text" && item.text.includes("| 名称")));
assert(flat.some((item) => item.tag === "code_block" && item.language === "ts" && item.text.includes("const x = 1;")));

const card = markdownToLarkCard(`# 卡片标题

看 [相对链接](README.md)。

\`\`\`ts
const x = 1;
\`\`\`
`);

assert.equal(card.header.title.content, "卡片标题");
assert(shouldUseLarkCard("```ts\nconst x = 1;\n```"));
assert(card.elements.some((item) => item.tag === "div" && item.text.content.includes("相对链接 (README.md)")));
assert(card.elements.some((item) => item.tag === "div" && item.text.tag === "lark_md" && item.text.content.includes("代码块 (ts)")));
assert(card.elements.some((item) => item.tag === "div" && item.text.tag === "plain_text" && item.text.content.includes("const x = 1;")));
assert(!card.elements.some((item) => item.tag === "div" && item.text.content.includes("```ts")));

console.log("markdown conversion tests passed");
