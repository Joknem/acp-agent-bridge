import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({
  path: path.resolve(process.cwd(), ".env"),
  override: true,
  quiet: true,
});

const envSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  ACP_DEFAULT_CWD: z.string().min(1).default(process.cwd()),
  KIMI_PATH: z.string().min(1).default("kimi"),
  AGENT_DEFAULT: z.string().min(1).default("kimi"),
  DEBUG: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  SHOW_THINKING_TOOL: z.enum(["force", "summary", "detailed"]).default("force"),
  FEISHU_DOMAIN: z.enum(["feishu", "lark"]).default("feishu"),
  FEISHU_ACK_ON_RECEIVE: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  FEISHU_ACK_MODE: z.enum(["off", "reaction", "message"]).optional(),
  FEISHU_ACK_REACTION: z.string().min(1).default("OK"),
  FEISHU_PROCESSING_REACTION: z.string().min(1).default("THINKING"),
  FEISHU_DONE_REACTION: z.string().optional().default(""),
  FEISHU_ERROR_REACTION: z.string().optional().default(""),
  FEISHU_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ACP_PROMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  STATE_FILE: z.string().min(1).default(".data/state.json"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${message}`);
  }

  const agents = parseAgentProviders(process.env, parsed.data.KIMI_PATH);
  const defaultAgent = parsed.data.AGENT_DEFAULT.toLowerCase();
  if (!agents.some((agent) => agent.name === defaultAgent)) {
    throw new Error(
      `AGENT_DEFAULT=${parsed.data.AGENT_DEFAULT} does not match any configured agent. Available: ${agents
        .map((agent) => agent.name)
        .join(", ")}`,
    );
  }

  return {
    feishu: {
      appId: parsed.data.FEISHU_APP_ID,
      appSecret: parsed.data.FEISHU_APP_SECRET,
      domain: parsed.data.FEISHU_DOMAIN,
    },
    acp: {
      cwd: path.resolve(parsed.data.ACP_DEFAULT_CWD),
      defaultAgent,
      agents,
      promptTimeoutMs: parsed.data.ACP_PROMPT_TIMEOUT_MS,
    },
    debug: parsed.data.DEBUG,
    showThinkingTool: parsed.data.SHOW_THINKING_TOOL,
    ackMode: parsed.data.FEISHU_ACK_MODE ?? (parsed.data.FEISHU_ACK_ON_RECEIVE ? "message" : "off"),
    ackReaction: normalizeReactionType(parsed.data.FEISHU_ACK_REACTION) ?? "OK",
    processingReaction: normalizeReactionType(parsed.data.FEISHU_PROCESSING_REACTION) ?? "THINKING",
    doneReaction: normalizeReactionType(parsed.data.FEISHU_DONE_REACTION),
    errorReaction: normalizeReactionType(parsed.data.FEISHU_ERROR_REACTION),
    sendTimeoutMs: parsed.data.FEISHU_SEND_TIMEOUT_MS,
    stateFile: path.resolve(parsed.data.STATE_FILE),
    logLevel: parsed.data.LOG_LEVEL,
  };
}

function normalizeReactionType(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function parseAgentProviders(env: NodeJS.ProcessEnv, legacyKimiPath: string) {
  const providers = new Map<string, { name: string; command: string; args: string[] }>();

  providers.set("kimi", {
    name: "kimi",
    command: env.AGENT_KIMI_COMMAND || legacyKimiPath,
    args: splitArgs(env.AGENT_KIMI_ARGS || "acp"),
  });

  for (const [key, value] of Object.entries(env)) {
    const match = /^AGENT_([A-Z0-9_]+)_COMMAND$/.exec(key);
    if (!match || !value?.trim()) continue;

    const name = match[1].toLowerCase();
    if (name === "default") continue;

    providers.set(name, {
      name,
      command: value.trim(),
      args: splitArgs(env[`AGENT_${match[1]}_ARGS`] || ""),
    });
  }

  return [...providers.values()];
}

function splitArgs(value: string) {
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
