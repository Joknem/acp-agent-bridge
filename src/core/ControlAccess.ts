export type ControlCommandPolicy = "open" | "allowlist";

export type ControlAccessConfig = {
  policy: ControlCommandPolicy;
  allowedUsers: string[];
};

export type ControlAccessSubject = {
  senderIds: string[];
};

export function parseControlAllowedUsers(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isControlAllowed(config: ControlAccessConfig, subject: ControlAccessSubject) {
  if (config.policy === "open") return true;
  if (!config.allowedUsers.length) return false;

  const allowed = new Set(config.allowedUsers);
  return subject.senderIds.some((id) => allowed.has(id));
}

export function controlDeniedMessage(config: ControlAccessConfig, subject: ControlAccessSubject) {
  return [
    "你没有权限执行这个控制命令。",
    "",
    `当前策略：${config.policy}`,
    `当前 sender：${subject.senderIds.length ? subject.senderIds.join(", ") : "unknown"}`,
    "请让管理员把你的 sender id 加入 CONTROL_COMMAND_ALLOWED_USERS。",
  ].join("\n");
}

export function maskControlUsers(users: readonly string[]) {
  return users.map(maskId);
}

function maskId(value: string) {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
