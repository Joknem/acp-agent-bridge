export function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function extractJsonText(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "object" && parsed && "text" in parsed) {
      const text = (parsed as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
  } catch {
    return "";
  }

  return "";
}
