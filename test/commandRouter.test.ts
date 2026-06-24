import assert from "node:assert/strict";
import { CommandRouter, isSlashCommand, parseSlashCommand } from "../src/core/CommandRouter.js";

assert.equal(parseSlashCommand("hello agent"), undefined);
assert.equal(isSlashCommand("  /help"), true);
assert.equal(isSlashCommand("plain text"), false);

const switchCommand = parseSlashCommand("/Agent switch Codex");
assert.deepEqual(switchCommand, {
  raw: "/Agent switch Codex",
  token: "/Agent",
  name: "agent",
  argsText: "switch Codex",
  args: ["switch", "Codex"],
});

const quotedCommand = parseSlashCommand('/project add "demo app" "/tmp/demo app"');
assert.deepEqual(quotedCommand?.args, ["add", "demo app", "/tmp/demo app"]);

const escapedCommand = parseSlashCommand("/bind new demo /tmp/demo\\ app");
assert.deepEqual(escapedCommand?.args, ["new", "demo", "/tmp/demo app"]);

const calls: string[] = [];
const router = new CommandRouter<{ platform: string }>()
  .register(["agent", "agents"], (command, context) => {
    calls.push(`${context.platform}:${command.name}:${command.args.join(",")}`);
  })
  .register("reset", (command, context) => {
    calls.push(`${context.platform}:${command.name}:${command.args.length}`);
  });

assert.equal(await router.dispatch("not a command", { platform: "qq" }), false);
assert.deepEqual(calls, []);

assert.equal(await router.dispatch("/agents codex", { platform: "qq" }), true);
assert.equal(await router.dispatch("/reset", { platform: "feishu" }), true);
assert.deepEqual(calls, ["qq:agents:codex", "feishu:reset:0"]);

const unknown: string[] = [];
assert.equal(
  await router.dispatch("/missing arg", { platform: "feishu" }, (command, context) => {
    unknown.push(`${context.platform}:${command.token}:${command.argsText}`);
  }),
  true,
);
assert.deepEqual(unknown, ["feishu:/missing:arg"]);

console.log("command router tests passed");
