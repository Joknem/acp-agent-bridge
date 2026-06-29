import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const managedKeys = [
  "FEISHU_BOT_ENABLED",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_DOMAIN",
  "ACP_DEFAULT_CWD",
  "ACP_ALLOWED_CWD_ROOTS",
  "AGENT_DEFAULT",
  "AGENT_CODEX_COMMAND",
  "AGENT_CODEX_ARGS",
  "AGENT_KIMI_COMMAND",
  "AGENT_KIMI_ARGS",
  "KIMI_PATH",
  "QQ_BOT_ENABLED",
  "QQ_BOT_APP_ID",
  "QQ_BOT_APP_SECRET",
  "QQ_BOT_TOKEN",
  "QQ_BOT_SANDBOX",
] as const;

const originalEnv = new Map<string, string | undefined>(managedKeys.map((key) => [key, process.env[key]]));

try {
  resetEnv({
    FEISHU_BOT_ENABLED: "false",
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
  });
  const qqOnly = loadConfig();
  assert.equal(qqOnly.feishu.enabled, false);
  assert.equal(qqOnly.feishu.appId, "");
  assert.equal(qqOnly.feishu.appSecret, "");

  resetEnv({
    FEISHU_BOT_ENABLED: "true",
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
  });
  assert.throws(() => loadConfig(), /FEISHU_BOT_ENABLED=true requires FEISHU_APP_ID and FEISHU_APP_SECRET/);

  resetEnv({
    FEISHU_BOT_ENABLED: "true",
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret",
  });
  const feishuEnabled = loadConfig();
  assert.equal(feishuEnabled.feishu.enabled, true);
  assert.equal(feishuEnabled.feishu.appId, "cli_test");

  console.log("config tests passed");
} finally {
  for (const key of managedKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resetEnv(overrides: Record<string, string>) {
  for (const key of managedKeys) delete process.env[key];
  Object.assign(process.env, {
    ACP_DEFAULT_CWD: process.cwd(),
    AGENT_DEFAULT: "codex",
    AGENT_CODEX_COMMAND: process.execPath,
    AGENT_CODEX_ARGS: "",
    QQ_BOT_ENABLED: "false",
    ...overrides,
  });
}
