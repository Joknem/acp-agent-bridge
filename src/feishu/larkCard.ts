import { Lexer, type Token, type Tokens } from "marked";

export type LarkCardContent = {
  config: {
    wide_screen_mode: boolean;
  };
  header: {
    template: "blue" | "red" | "green" | "orange" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: LarkCardElement[];
};

type LarkCardElement =
  | {
      tag: "div";
      text: {
        tag: "lark_md" | "plain_text";
        content: string;
      };
    }
  | {
      tag: "hr";
    };

const MAX_TITLE_LENGTH = 80;
const MAX_ELEMENT_LENGTH = 2800;
const MAX_ELEMENTS = 20;

export function shouldUseLarkCard(markdown: string) {
  return /```/.test(markdown) || /^\|.+\|$/m.test(markdown) || markdown.length > 3500;
}

export function markdownToLarkCard(markdown: string, fallbackTitle = "Agent 回复"): LarkCardContent {
  const tokens = Lexer.lex(markdown, { gfm: true, breaks: false });
  const elements: LarkCardElement[] = [];
  const markdownBlocks: string[] = [];
  let title = fallbackTitle;
  let consumedTitle = false;

  const flushMarkdown = () => {
    const body = sanitizeMarkdownLinks(markdownBlocks.filter(Boolean).join("\n\n").trim());
    markdownBlocks.length = 0;
    appendMarkdownElements(elements, body);
  };

  for (const token of tokens) {
    if (token.type === "space") continue;

    if (token.type === "heading" && !consumedTitle) {
      const heading = token as Tokens.Heading;
      const headingText = plainText(heading.tokens).trim();
      if (headingText) title = headingText.slice(0, MAX_TITLE_LENGTH);
      consumedTitle = true;
      continue;
    }

    if (token.type === "code") {
      flushMarkdown();
      appendCodeElement(elements, token as Tokens.Code);
      continue;
    }

    if (token.type === "table") {
      flushMarkdown();
      appendPlainTextBlock(elements, "表格", tableToText(token as Tokens.Table));
      continue;
    }

    markdownBlocks.push(tokenToMarkdown(token));
  }

  flushMarkdown();

  if (!elements.length) {
    appendMarkdownElements(elements, "(empty response)");
  }

  if (elements.length > MAX_ELEMENTS) {
    elements.splice(MAX_ELEMENTS);
    appendSeparator(elements);
    appendDiv(elements, "lark_md", "_输出过长，后续内容已截断。_");
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements,
  };
}

function appendMarkdownElements(elements: LarkCardElement[], markdown: string) {
  if (!markdown.trim()) return;

  for (const chunk of chunkMarkdown(markdown)) {
    appendSeparator(elements);
    appendDiv(elements, "lark_md", chunk);
  }
}

function appendCodeElement(elements: LarkCardElement[], code: Tokens.Code) {
  const language = code.lang?.split(/\s+/)[0]?.trim() ?? "";
  appendPlainTextBlock(elements, `代码块${language ? ` (${language})` : ""}`, code.text);
}

function appendPlainTextBlock(elements: LarkCardElement[], label: string, text: string) {
  appendSeparator(elements);
  appendDiv(elements, "lark_md", `**${escapeLarkMarkdown(label)}**`);

  for (const chunk of chunkPlainText(text)) {
    appendSeparator(elements);
    appendDiv(elements, "plain_text", chunk);
  }
}

function appendSeparator(elements: LarkCardElement[]) {
  if (elements.length && elements.at(-1)?.tag !== "hr") {
    elements.push({ tag: "hr" });
  }
}

function appendDiv(elements: LarkCardElement[], tag: "lark_md" | "plain_text", content: string) {
  elements.push({
    tag: "div",
    text: {
      tag,
      content,
    },
  });
}

function tokenToMarkdown(token: Token): string {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return `${"#".repeat(heading.depth)} ${plainText(heading.tokens)}`;
    }
    case "paragraph":
      return (token as Tokens.Paragraph).raw.trim();
    case "blockquote":
      return (token as Tokens.Blockquote).raw.trim();
    case "list":
      return (token as Tokens.List).raw.trim();
    case "code": {
      const code = token as Tokens.Code;
      const lang = code.lang?.split(/\s+/)[0]?.trim() ?? "";
      return `\`\`\`${lang}\n${code.text}\n\`\`\``;
    }
    case "table":
      return (token as Tokens.Table).raw.trim();
    case "hr":
      return "---";
    case "html":
      return (token as Tokens.HTML).text;
    case "text":
      return (token as Tokens.Text).raw.trim();
    default:
      return "raw" in token && typeof token.raw === "string" ? token.raw.trim() : "";
  }
}

function tableToText(table: Tokens.Table) {
  const header = table.header.map((cell) => cell.text.trim());
  const bodyRows = table.rows.map((row) => row.map((cell) => cell.text.trim()));
  const widths = header.map((value, index) =>
    Math.max(value.length, ...bodyRows.map((row) => row[index]?.length ?? 0), 3),
  );

  const renderRow = (cells: string[]) => `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 3)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(header), separator, ...bodyRows.map(renderRow)].join("\n");
}

function chunkMarkdown(markdown: string) {
  const chunks: string[] = [];
  let current = "";

  for (const block of markdown.split(/\n{2,}/)) {
    if (block.length > MAX_ELEMENT_LENGTH) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...chunkLongBlock(block));
      continue;
    }

    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > MAX_ELEMENT_LENGTH) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function chunkLongBlock(block: string) {
  const chunks: string[] = [];
  const isFence = block.startsWith("```");
  const fenceMatch = /^```([^\n]*)\n([\s\S]*)\n```$/.exec(block);

  if (isFence && fenceMatch) {
    const language = fenceMatch[1] ?? "";
    const code = fenceMatch[2] ?? "";
    const maxCodeLength = MAX_ELEMENT_LENGTH - language.length - 16;
    for (let index = 0; index < code.length; index += maxCodeLength) {
      chunks.push(`\`\`\`${language}\n${code.slice(index, index + maxCodeLength)}\n\`\`\``);
    }
    return chunks;
  }

  for (let index = 0; index < block.length; index += MAX_ELEMENT_LENGTH) {
    chunks.push(block.slice(index, index + MAX_ELEMENT_LENGTH));
  }
  return chunks;
}

function chunkPlainText(text: string) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_ELEMENT_LENGTH) {
    chunks.push(text.slice(index, index + MAX_ELEMENT_LENGTH));
  }
  return chunks.length ? chunks : [""];
}

function sanitizeMarkdownLinks(markdown: string) {
  return markdown.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, text: string, href: string) => {
    return isValidLarkHref(href) ? full : `${text} (${href})`;
  });
}

function isValidLarkHref(href: string) {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function escapeLarkMarkdown(text: string) {
  return text.replace(/([*_`~])/g, "\\$1");
}

function plainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "escape":
        case "codespan":
          return (token as Tokens.Text | Tokens.Escape | Tokens.Codespan).text;
        case "strong":
        case "em":
        case "del":
        case "link":
          return plainText((token as Tokens.Strong | Tokens.Em | Tokens.Del | Tokens.Link).tokens);
        case "image":
          return (token as Tokens.Image).text;
        case "br":
          return "\n";
        default:
          return "raw" in token && typeof token.raw === "string" ? token.raw : "";
      }
    })
    .join("");
}
