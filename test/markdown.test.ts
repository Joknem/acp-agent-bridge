import assert from "node:assert/strict";
import { markdownToLarkCard, markdownToLarkCards, shouldUseLarkCard } from "../src/feishu/larkCard.js";
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

const skillPost = markdownToLarkPost(`你当前可用的 skills 有：

- \`imagegen\`: 生成或编辑位图图片、插画、纹理。
- \`openai-docs\`: 查询和引用 OpenAI / Codex 官方文档。
`);
const skillRows = skillPost.zh_cn.content.map((row) => row.map((item) => item.text).join(""));

assert.equal(skillRows.filter((row) => row.includes("imagegen")).length, 1);
assert.equal(skillRows.filter((row) => row.includes("openai-docs")).length, 1);
assert(skillRows.some((row) => row.startsWith("- ") && row.includes("imagegen")));
assert(skillRows.some((row) => row.startsWith("- ") && row.includes("openai-docs")));

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

const longCode = Array.from(
  { length: 1500 },
  (_, index) => `line ${index.toString().padStart(4, "0")} ${"x".repeat(50)}`,
).join("\n");
const cards = markdownToLarkCards(["# 长回复", "", "```txt", longCode, "```"].join("\n"));
const cardText = cards
  .flatMap((item) => item.elements)
  .filter((item) => item.tag === "div")
  .map((item) => item.text.content)
  .join("\n");

assert(cards.length > 1);
assert(cards.every((item) => item.elements.length <= 20));
assert(cards[0]?.header.title.content.endsWith(`(1/${cards.length})`));
assert(cards.at(-1)?.header.title.content.endsWith(`(${cards.length}/${cards.length})`));
assert(!cardText.includes("截断"));
assert(cardText.includes("line 0000"));
assert(cardText.includes("line 1499"));

console.log("markdown conversion tests passed");
