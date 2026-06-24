export type SlashCommand = {
  raw: string;
  token: string;
  name: string;
  argsText: string;
  args: string[];
};

export type CommandHandler<TContext> = (command: SlashCommand, context: TContext) => Promise<void> | void;

export class CommandRouter<TContext> {
  private readonly handlers = new Map<string, CommandHandler<TContext>>();

  register(names: string | string[], handler: CommandHandler<TContext>) {
    for (const name of Array.isArray(names) ? names : [names]) {
      this.handlers.set(normalizeCommandName(name), handler);
    }

    return this;
  }

  async dispatch(text: string, context: TContext, unknownHandler?: CommandHandler<TContext>) {
    const command = parseSlashCommand(text);
    if (!command) return false;

    const handler = this.handlers.get(command.name);
    if (handler) {
      await handler(command, context);
      return true;
    }

    if (unknownHandler) {
      await unknownHandler(command, context);
    }
    return true;
  }
}

export function parseSlashCommand(text: string): SlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return {
      raw: trimmed,
      token: trimmed.split(/\s+/, 1)[0] || "/",
      name: "",
      argsText: "",
      args: [],
    };
  }

  const commandName = normalizeCommandName(match[1] ?? "");
  const argsText = (match[2] ?? "").trim();
  return {
    raw: trimmed,
    token: `/${match[1] ?? ""}`,
    name: commandName,
    argsText,
    args: splitCommandArgs(argsText),
  };
}

export function isSlashCommand(text: string) {
  return parseSlashCommand(text) !== undefined;
}

function normalizeCommandName(name: string) {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function splitCommandArgs(value: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}
