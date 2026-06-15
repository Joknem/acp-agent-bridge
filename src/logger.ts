import type { AppConfig } from "./config.js";

const weights = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(level: AppConfig["logLevel"]) {
  const threshold = weights[level];

  function enabled(target: keyof typeof weights) {
    return weights[target] >= threshold;
  }

  return {
    trace(message: string, meta?: unknown) {
      if (enabled("trace")) console.debug(format(message, meta));
    },
    debug(message: string, meta?: unknown) {
      if (enabled("debug")) console.debug(format(message, meta));
    },
    info(message: string, meta?: unknown) {
      if (enabled("info")) console.info(format(message, meta));
    },
    warn(message: string, meta?: unknown) {
      if (enabled("warn")) console.warn(format(message, meta));
    },
    error(message: string, meta?: unknown) {
      if (enabled("error")) console.error(format(message, meta));
    },
  };
}

function format(message: string, meta?: unknown) {
  if (meta === undefined) return message;
  return `${message} ${JSON.stringify(meta)}`;
}
