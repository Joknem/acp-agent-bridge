import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { formatDoctorReport, parseDoctorScope, runDoctor } from "../src/core/Doctor.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-doctor-"));
const stateFile = path.join(dir, "state.json");
await fs.writeFile(stateFile, "{}\n", "utf8");

const config = {
  feishu: {
    appId: "cli_1234567890",
    appSecret: "secret",
    domain: "feishu",
  },
  acp: {
    cwd: dir,
    defaultAgent: "codex",
    promptTimeoutMs: 120_000,
    agents: [
      {
        name: "codex",
        command: process.execPath,
        args: ["-c", 'model="gpt-5.5"', "-c", 'model_reasoning_effort="high"'],
      },
      {
        name: "missing",
        command: "definitely-not-a-real-command",
        args: [],
      },
    ],
  },
  qq: {
    enabled: true,
    appId: "1904411437",
    appSecret: "secret",
    token: "",
    apiBase: "https://sandbox.api.sgroup.qq.com",
    intents: 33554432,
    replyMaxChars: 1800,
    reconnectMs: 5000,
    imageMaxBytes: 10 * 1024 * 1024,
    messageMergeWindowMs: 2000,
  },
  debug: false,
  showThinkingTool: "force",
  ackMode: "reaction",
  ackReaction: "OK",
  processingReaction: "THINKING",
  doneReaction: undefined,
  errorReaction: undefined,
  sendTimeoutMs: 15_000,
  imageMaxBytes: 10 * 1024 * 1024,
  messageMergeWindowMs: 2000,
  stateFile,
  logLevel: "info",
} satisfies AppConfig;

assert.equal(parseDoctorScope("agents"), "agent");
assert.equal(parseDoctorScope("qq"), "qq");
assert.equal(parseDoctorScope("unknown"), "all");

const report = await runDoctor({
  config,
  providers: [
    { ...config.acp.agents[0], isDefault: true, isRunning: true },
    { ...config.acp.agents[1], isDefault: false, isRunning: false },
  ],
  state: {
    projects: 2,
    bindings: 1,
    processedMessages: 3,
  },
  chat: {
    chatId: "chat-a",
    chatType: "p2p",
    currentProvider: "codex",
    currentCwd: dir,
    queued: 0,
  },
  platform: {
    feishu: [{ status: "ok", label: "凭证实时检查", detail: "通过" }],
    qq: [{ status: "ok", label: "Gateway", detail: "open" }],
  },
});

const formatted = formatDoctorReport(report);
assert(formatted.includes("model=gpt-5.5"));
assert(formatted.includes("reasoning=high"));
assert(formatted.includes("definitely-not-a-real-command"));
assert(formatted.includes("FAIL"));
assert(formatted.includes("Gateway"));
assert(formatted.includes("当前聊天"));

const agentOnly = await runDoctor({
  config,
  providers: [{ ...config.acp.agents[0], isDefault: true, isRunning: true }],
  state: {
    projects: 0,
    bindings: 0,
    processedMessages: 0,
  },
  scope: "agent",
});
assert.deepEqual(agentOnly.sections.map((section) => section.title), ["Agent"]);

console.log("doctor tests passed");
