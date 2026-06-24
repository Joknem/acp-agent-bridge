import assert from "node:assert/strict";
import { formatCommandForDisplay, redactCommandArgs } from "../src/core/CommandRedaction.js";

const redacted = redactCommandArgs([
  "--model",
  "gpt-5",
  "--api-key",
  "sk-live-secretsecret",
  "OPENAI_API_KEY=sk-proj-secretsecret",
  "--client-secret=client-secret-value",
  "Bearer abcdefghijklmnop",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
]);

assert.deepEqual(redacted, [
  "--model",
  "gpt-5",
  "--api-key",
  "<redacted>",
  "OPENAI_API_KEY=<redacted>",
  "--client-secret=<redacted>",
  "<redacted>",
  "<redacted>",
]);

assert.equal(formatCommandForDisplay("codex", ["--model", "gpt-5", "--token", "secret-token"]), "codex --model gpt-5 --token <redacted>");

console.log("command redaction tests passed");
