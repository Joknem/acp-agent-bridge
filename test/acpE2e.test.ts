import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../src/acp/AgentManager.js";
import type { PermissionMode } from "../src/acp/PermissionPolicy.js";
import { AgentPromptError, type AgentPromptContent } from "../src/acp/types.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { StateStore } from "../src/state/StateStore.js";

const fakeAgentPath = path.resolve("test/fixtures/fakeAcpAgent.mjs");

const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-e2e-"));
const prompt: AgentPromptContent = [{ type: "text", text: "hello fake agent" }];

await testPromptAndResume();
await testTimeoutCancelDiagnostics();
await testPermissionPolicy("allow_once", "allow-once");
await testPermissionPolicy("allow_always", "allow-always");
await testPermissionPolicy("deny", "reject-once");
await testPermissionAskInChat();

console.log("acp e2e tests passed");

async function testPromptAndResume() {
  const stateFile = path.join(root, "resume-state.json");
  const stateStore = new StateStore(stateFile, logger);
  await stateStore.load();

  const config = makeConfig(root, ["--mode=normal"], 1_000);
  const manager = new AgentManager(config, logger, stateStore);

  try {
    const firstTurn = await manager.prompt("chat-a", prompt, { turnId: "turn-first" });
    assert(firstTurn.answerMarkdown.includes("fake reply"));
    assert(firstTurn.answerMarkdown.includes("resumed=false"));
    assert.equal(firstTurn.provider, "fake");

    await stateStore.flush();
    assert.equal(stateStore.getChatSession("chat-a", "fake")?.sessionId, firstTurn.sessionId);

    await manager.stopAll();

    const resumedManager = new AgentManager(config, logger, stateStore);
    try {
      assert.equal(resumedManager.currentSessionInfo("chat-a").source, "persisted");
      const secondTurn = await resumedManager.prompt("chat-a", prompt, { turnId: "turn-second" });

      assert.equal(secondTurn.sessionId, firstTurn.sessionId);
      assert(secondTurn.answerMarkdown.includes("resumed=true"));
      assert.equal(resumedManager.currentSessionInfo("chat-a").source, "resumed");
    } finally {
      await resumedManager.stopAll();
    }
  } finally {
    await manager.stopAll();
  }
}

async function testTimeoutCancelDiagnostics() {
  const stateFile = path.join(root, "timeout-state.json");
  const stateStore = new StateStore(stateFile, logger);
  await stateStore.load();

  const manager = new AgentManager(makeConfig(root, ["--mode=timeout"], 60), logger, stateStore);

  try {
    await assert.rejects(
      () => manager.prompt("chat-timeout", prompt, { turnId: "turn-timeout" }),
      (error: unknown) => {
        assert(error instanceof AgentPromptError);
        assert.equal(error.details.turnId, "turn-timeout");
        assert.equal(error.details.timedOut, true);
        assert.equal(error.details.timeoutMs, 60);
        assert.equal(error.details.cancelAfterTimeout, "succeeded");
        assert(error.details.recentStderr.some((line) => line.includes("fake timeout stderr")));
        return true;
      },
    );

    await stateStore.flush();
    assert.equal(stateStore.chatSessionCount(), 0);
  } finally {
    await manager.stopAll();
  }
}

async function testPermissionPolicy(permissionMode: PermissionMode, expectedOptionId: string) {
  const stateFile = path.join(root, `permission-${permissionMode}.json`);
  const stateStore = new StateStore(stateFile, logger);
  await stateStore.load();

  const manager = new AgentManager(makeConfig(root, ["--mode=permission"], 1_000, permissionMode), logger, stateStore);

  try {
    const turn = await manager.prompt(`chat-permission-${permissionMode}`, prompt, { turnId: `turn-permission-${permissionMode}` });
    assert(turn.answerMarkdown.includes(`permission=${expectedOptionId}`));
    assert(turn.toolMarkdown.includes(`Permission selected by policy ${permissionMode}`));
  } finally {
    await manager.stopAll();
  }
}

async function testPermissionAskInChat() {
  const stateFile = path.join(root, "permission-ask-in-chat.json");
  const stateStore = new StateStore(stateFile, logger);
  await stateStore.load();

  const manager = new AgentManager(makeConfig(root, ["--mode=permission"], 1_000, "ask_in_chat"), logger, stateStore);

  try {
    const turn = await manager.prompt("chat-permission-ask", prompt, {
      turnId: "turn-permission-ask",
      permissionHandler: async (context) => {
        assert.equal(context.provider, "fake");
        assert.equal(context.turnId, "turn-permission-ask");
        assert.equal(context.request.toolCall.title, "Fake permission tool");
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow-always",
          },
        };
      },
    });
    assert(turn.answerMarkdown.includes("permission=allow-always"));
    assert(turn.toolMarkdown.includes("Permission selected in chat: Allow always"));
  } finally {
    await manager.stopAll();
  }
}

function makeConfig(cwd: string, extraArgs: string[], promptTimeoutMs: number, permissionMode: PermissionMode = "allow_once"): AppConfig {
  return {
    feishu: {
      appId: "cli_fake",
      appSecret: "secret",
      domain: "feishu",
    },
    acp: {
      cwd,
      defaultAgent: "fake",
      agents: [
        {
          name: "fake",
          command: process.execPath,
          args: [fakeAgentPath, ...extraArgs],
        },
      ],
      promptTimeoutMs,
      permissionMode,
      permissionRequestTimeoutMs: 60_000,
    },
    qq: {
      enabled: false,
      appId: "",
      appSecret: "",
      token: "",
      apiBase: "https://sandbox.api.sgroup.qq.com",
      intents: 1 << 25,
      replyMaxChars: 1800,
      reconnectMs: 5000,
      imageMaxBytes: 10 * 1024 * 1024,
      messageMergeWindowMs: 2000,
    },
    debug: false,
    showThinkingTool: "force",
    ackMode: "off",
    ackReaction: "OK",
    processingReaction: "THINKING",
    doneReaction: undefined,
    errorReaction: undefined,
    sendTimeoutMs: 15_000,
    imageMaxBytes: 10 * 1024 * 1024,
    messageMergeWindowMs: 2000,
    stateFile: path.join(cwd, "state.json"),
    logLevel: "error",
  };
}
