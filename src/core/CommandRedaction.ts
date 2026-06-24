const REDACTED = "<redacted>";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "apitoken",
  "appsecret",
  "auth",
  "authentication",
  "authorization",
  "authtoken",
  "clientsecret",
  "credential",
  "credentials",
  "privatekey",
  "password",
  "passwd",
  "pwd",
  "refreshtoken",
  "secret",
  "sessionkey",
  "token",
  "accesstoken",
]);

const SENSITIVE_KEY_PARTS = [
  "apikey",
  "apitoken",
  "appsecret",
  "authtoken",
  "clientsecret",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionkey",
  "token",
  "accesstoken",
];

export function formatCommandForDisplay(command: string, args: readonly string[]) {
  return [command, ...redactCommandArgs(args)].join(" ").trim();
}

export function redactCommandArgs(args: readonly string[]) {
  const redacted: string[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      redacted.push(REDACTED);
      redactNext = false;
      continue;
    }

    const assignment = splitAssignment(arg);
    if (assignment && (isSensitiveKey(assignment.key) || looksLikeSecretValue(assignment.value))) {
      redacted.push(`${assignment.prefix}${assignment.key}${assignment.separator}${REDACTED}`);
      continue;
    }

    if (isSensitiveFlag(arg)) {
      redacted.push(arg);
      redactNext = true;
      continue;
    }

    redacted.push(looksLikeSecretValue(arg) ? REDACTED : arg);
  }

  return redacted;
}

function splitAssignment(arg: string) {
  const match = /^((?:--?)?)([A-Za-z0-9_.-]+)(=)([\s\S]*)$/.exec(arg);
  if (!match) return undefined;
  return {
    prefix: match[1],
    key: match[2],
    separator: match[3],
    value: match[4],
  };
}

function isSensitiveFlag(arg: string) {
  const normalized = normalizeKey(arg.replace(/^--?/, ""));
  return SENSITIVE_KEYS.has(normalized);
}

function isSensitiveKey(key: string) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function normalizeKey(key: string) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function looksLikeSecretValue(value: string) {
  return (
    /^sk-[A-Za-z0-9_-]{12,}$/.test(value) ||
    /^sk-proj-[A-Za-z0-9_-]{12,}$/.test(value) ||
    /^ghp_[A-Za-z0-9_]{20,}$/.test(value) ||
    /^github_pat_[A-Za-z0-9_]{20,}$/.test(value) ||
    /^xox[baprs]-[A-Za-z0-9-]{12,}$/.test(value) ||
    /^Bearer\s+\S+/i.test(value) ||
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}
