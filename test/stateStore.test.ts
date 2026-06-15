import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state/StateStore.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-agent-state-"));
const filePath = path.join(dir, "state.json");

await fs.writeFile(
  filePath,
  `${JSON.stringify({
    version: 1,
    chats: {
      chat_a: {
        providerName: "codex",
        cwd: "/tmp/project-a",
      },
    },
    projects: {
      acp: "/tmp/acp-create",
    },
  })}\n`,
  "utf8",
);

const store = new StateStore(filePath, logger);
await store.load();

assert.deepEqual(store.listBindings(), []);
assert.equal(store.getChat("chat_a")?.providerName, "codex");
assert.equal(store.getProject("ACP"), "/tmp/acp-create");

store.setBinding("group_a", {
  cwd: "/tmp/acp-create",
  projectName: "acp",
});
await store.flush();

const binding = store.getBinding("group_a");
assert.equal(binding?.cwd, "/tmp/acp-create");
assert.equal(binding?.projectName, "acp");
assert.equal(typeof binding?.createdAt, "number");
assert.equal(typeof binding?.updatedAt, "number");
assert.equal(store.listBindings().length, 1);

assert.equal(store.deleteBinding("group_a"), true);
assert.equal(store.deleteBinding("group_a"), false);
await store.flush();
assert.equal(store.getBinding("group_a"), undefined);

console.log("state store tests passed");
