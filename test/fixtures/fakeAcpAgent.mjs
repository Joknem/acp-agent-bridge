import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "normal";
let nextSession = 1;
const resumedSessions = new Set();

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
        },
      },
      authMethods: [],
    };
  }

  async newSession(params) {
    return {
      sessionId: `fake-session-${nextSession++}`,
      _meta: {
        cwd: params.cwd,
      },
    };
  }

  async resumeSession(params) {
    resumedSessions.add(params.sessionId);
    return {};
  }

  async loadSession(params) {
    resumedSessions.add(params.sessionId);
    return {};
  }

  async prompt(params) {
    if (mode === "timeout") {
      process.stderr.write(`fake timeout stderr for ${params.sessionId}\n`);
      await delay(10_000);
      return { stopReason: "end_turn" };
    }

    const text = promptText(params.prompt);
    const wasResumed = resumedSessions.has(params.sessionId);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `fake reply session=${params.sessionId} resumed=${wasResumed} text=${text}`,
        },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel(params) {
    process.stderr.write(`fake cancel ${params.sessionId}\n`);
    return {};
  }
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const connection = new AgentSideConnection((conn) => new FakeAgent(conn), ndJsonStream(input, output));

await connection.closed;
