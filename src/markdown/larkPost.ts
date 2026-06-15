import { Lexer, type Token, type Tokens } from "marked";

export type LarkPostTextStyle = "bold" | "italic" | "underline" | "lineThrough" | "code";

export type LarkPostElement =
  | {
      tag: "text";
      text: string;
      style?: LarkPostTextStyle[];
      un_escape?: boolean;
    }
  | {
      tag: "a";
      text: string;
      href: string;
      style?: LarkPostTextStyle[];
    }
  | {
      tag: "code_block";
      language?: string;
      text: string;
    };

export type LarkPostContent = {
  zh_cn: {
    title: string;
    content: LarkPostElement[][];
  };
};

type InlineStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  lineThrough?: boolean;
  code?: boolean;
};

const MAX_TITLE_LENGTH = 80;
const BULLET_INDENTS = ["", "  ", "    ", "      "];

export function markdownToLarkPost(markdown: string, fallbackTitle = "Kimi 回复"): LarkPostContent {
  const tokens = Lexer.lex(markdown, { gfm: true, breaks: false });
  const rows: LarkPostElement[][] = [];
  let title = fallbackTitle;
  let consumedTitle = false;

  for (const token of tokens) {
    if (token.type === "space") continue;

    if (token.type === "heading" && !consumedTitle) {
      const heading = token as Tokens.Heading;
      const headingText = plainText(heading.tokens).trim();
      if (headingText) title = headingText.slice(0, MAX_TITLE_LENGTH);
      consumedTitle = true;
      continue;
    }

    appendBlock(rows, token, 0);
  }

  return {
    zh_cn: {
      title,
      content: compactRows(rows),
    },
  };
}

function appendBlock(rows: LarkPostElement[][], token: Token, depth: number) {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      const prefix = heading.depth <= 2 ? "■ " : `${"#".repeat(heading.depth)} `;
      rows.push([{ tag: "text", text: prefix, style: ["bold"] }, ...inlineToElements(heading.tokens, { bold: true })]);
      break;
    }
    case "paragraph": {
      rows.push(inlineToElements((token as Tokens.Paragraph).tokens, {}));
      break;
    }
    case "blockquote": {
      for (const nested of (token as Tokens.Blockquote).tokens) {
        const before = rows.length;
        appendBlock(rows, nested, depth);
        for (const row of rows.slice(before)) {
          row.unshift({ tag: "text", text: "> " });
        }
      }
      break;
    }
    case "list": {
      const list = token as Tokens.List;
      list.items.forEach((item, index) => appendListItem(rows, list, item, index, depth));
      break;
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = normalizeCodeLanguage(code.lang);
      rows.push([{ tag: "text", text: `代码块${language ? ` (${language})` : ""}`, style: ["bold"] }]);
      rows.push([
        {
          tag: "code_block",
          language: language || "text",
          text: code.text,
        },
      ]);
      break;
    }
    case "table": {
      appendTable(rows, token as Tokens.Table);
      break;
    }
    case "hr": {
      rows.push([{ tag: "text", text: "──────────" }]);
      break;
    }
    case "html": {
      rows.push([{ tag: "text", text: (token as Tokens.HTML).text }]);
      break;
    }
    case "text": {
      const text = token as Tokens.Text;
      rows.push(inlineToElements(text.tokens ?? [text], {}));
      break;
    }
    default:
      if ("raw" in token && typeof token.raw === "string" && token.raw.trim()) {
        rows.push([{ tag: "text", text: token.raw }]);
      }
  }
}

function appendListItem(
  rows: LarkPostElement[][],
  list: Tokens.List,
  item: Tokens.ListItem,
  index: number,
  depth: number,
) {
  const marker = list.ordered ? `${Number(list.start || 1) + index}. ` : "- ";
  const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
  const indent = BULLET_INDENTS[Math.min(depth, BULLET_INDENTS.length - 1)] ?? "";

  const firstContentIndex = item.tokens.findIndex((token) => token.type !== "space");
  const firstContentToken = firstContentIndex >= 0 ? item.tokens[firstContentIndex] : undefined;
  const nestedTokens = firstContentIndex >= 0 ? item.tokens.slice(firstContentIndex + 1) : [];
  const row = listItemRow(firstContentToken, item);

  rows.push([{ tag: "text", text: `${indent}${marker}${checkbox}` }, ...row]);

  for (const nested of nestedTokens) {
    if (nested.type === "space") continue;
    appendBlock(rows, nested, depth + 1);
  }
}

function listItemRow(firstToken: Token | undefined, item: Tokens.ListItem): LarkPostElement[] {
  if (firstToken?.type === "paragraph") {
    return inlineToElements((firstToken as Tokens.Paragraph).tokens, {});
  }

  if (firstToken?.type === "text") {
    const text = firstToken as Tokens.Text;
    return inlineToElements(text.tokens ?? [text], {});
  }

  return [{ tag: "text", text: item.text.split("\n")[0] ?? "" }];
}

function appendTable(rows: LarkPostElement[][], table: Tokens.Table) {
  const header = table.header.map((cell) => cell.text.trim());
  const bodyRows = table.rows.map((row) => row.map((cell) => cell.text.trim()));
  const widths = header.map((value, index) =>
    Math.max(value.length, ...bodyRows.map((row) => row[index]?.length ?? 0), 3),
  );

  const renderRow = (cells: string[]) => `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 3)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  const tableText = [renderRow(header), separator, ...bodyRows.map(renderRow)].join("\n");

  rows.push([{ tag: "text", text: "表格", style: ["bold"] }]);
  rows.push([{ tag: "code_block", language: "text", text: tableText }]);
}

function inlineToElements(tokens: Token[], inherited: InlineStyle): LarkPostElement[] {
  const elements: LarkPostElement[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const text = token as Tokens.Text | Tokens.Escape;
        if ("tokens" in text && text.tokens?.length) {
          elements.push(...inlineToElements(text.tokens, inherited));
        } else {
          elements.push(textElement(text.text, inherited));
        }
        break;
      }
      case "strong":
        elements.push(...inlineToElements((token as Tokens.Strong).tokens, { ...inherited, bold: true }));
        break;
      case "em":
        elements.push(...inlineToElements((token as Tokens.Em).tokens, { ...inherited, italic: true }));
        break;
      case "del":
        elements.push(...inlineToElements((token as Tokens.Del).tokens, { ...inherited, lineThrough: true }));
        break;
      case "codespan":
        elements.push(textElement((token as Tokens.Codespan).text, { ...inherited, code: true }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const text = plainText(link.tokens) || link.href;
        if (isValidLarkHref(link.href)) {
          elements.push({
            tag: "a",
            text,
            href: link.href,
            style: styleArray(inherited),
          });
        } else {
          elements.push(textElement(`${text} (${link.href})`, inherited));
        }
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        elements.push(textElement(`[image: ${image.text || image.href}]`, inherited));
        break;
      }
      case "br":
        elements.push(textElement("\n", inherited));
        break;
      case "html":
        elements.push(...htmlInlineToElements((token as Tokens.HTML).text, inherited));
        break;
      default:
        if ("raw" in token && typeof token.raw === "string") {
          elements.push(textElement(token.raw, inherited));
        }
    }
  }

  return mergeAdjacentText(elements).filter((element) => element.tag !== "text" || element.text.length > 0);
}

function htmlInlineToElements(text: string, inherited: InlineStyle) {
  const underlineMatch = /^<u>([\s\S]*)<\/u>$/.exec(text);
  if (underlineMatch) {
    return [textElement(underlineMatch[1] ?? "", { ...inherited, underline: true })];
  }

  return [textElement(text, inherited)];
}

function textElement(text: string, style: InlineStyle): LarkPostElement {
  const styles = styleArray(style);
  return styles.length ? { tag: "text", text, style: styles } : { tag: "text", text };
}

function styleArray(style: InlineStyle): LarkPostTextStyle[] {
  return [
    style.bold ? "bold" : undefined,
    style.italic ? "italic" : undefined,
    style.underline ? "underline" : undefined,
    style.lineThrough ? "lineThrough" : undefined,
    style.code ? "code" : undefined,
  ].filter((value): value is LarkPostTextStyle => Boolean(value));
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

function mergeAdjacentText(elements: LarkPostElement[]) {
  const merged: LarkPostElement[] = [];

  for (const element of elements) {
    const previous = merged.at(-1);
    if (
      element.tag === "text" &&
      previous?.tag === "text" &&
      JSON.stringify(previous.style ?? []) === JSON.stringify(element.style ?? [])
    ) {
      previous.text += element.text;
    } else {
      merged.push(element);
    }
  }

  return merged;
}

function compactRows(rows: LarkPostElement[][]) {
  const compacted = insertSpacing(splitRowsByNewlines(rows))
    .map((row) => row.filter((element) => element.tag !== "text" || element.text.length > 0))
    .filter((row) => row.length > 0);

  const fallback: LarkPostElement[][] = [[{ tag: "text", text: "(empty response)" }]];
  return compacted.length ? compacted : fallback;
}

function splitRowsByNewlines(rows: LarkPostElement[][]) {
  const splitRows: LarkPostElement[][] = [];

  for (const row of rows) {
    if (isCodeBlockRow(row)) {
      splitRows.push(row);
      continue;
    }

    let current: LarkPostElement[] = [];

    for (const element of row) {
      if (element.tag !== "text" || !element.text.includes("\n")) {
        current.push(element);
        continue;
      }

      const parts = element.text.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) {
          splitRows.push(current);
          current = [];
        }

        if (part) {
          current.push({ ...element, text: part });
        }
      });
    }

    splitRows.push(current);
  }

  return splitRows;
}

function insertSpacing(rows: LarkPostElement[][]) {
  const spaced: LarkPostElement[][] = [];

  for (const row of rows) {
    const previous = spaced.at(-1);
    if (previous && shouldInsertBlankLine(previous, row)) {
      spaced.push([{ tag: "text", text: " " }]);
    }
    spaced.push(row);
  }

  return spaced;
}

function shouldInsertBlankLine(previous: LarkPostElement[], current: LarkPostElement[]) {
  if (isBlankRow(previous) || isBlankRow(current)) return false;
  if (isListRow(previous) && isListRow(current)) return false;
  if (isCodeBlockRow(previous) || isCodeBlockRow(current)) return false;
  return true;
}

function isBlankRow(row: LarkPostElement[]) {
  return row.length === 1 && row[0]?.tag === "text" && row[0].text.trim() === "";
}

function isListRow(row: LarkPostElement[]) {
  const first = row[0];
  return first?.tag === "text" && /^\s*(?:-|\d+\.|\[[ x]\])/.test(first.text);
}

function isCodeBlockRow(row: LarkPostElement[]) {
  return row.length === 1 && row[0]?.tag === "code_block";
}

function normalizeCodeLanguage(language?: string) {
  if (!language) return "";
  return language.split(/\s+/)[0]?.trim().toLowerCase() ?? "";
}

function isValidLarkHref(href: string) {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}
