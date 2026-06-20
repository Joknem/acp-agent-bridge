import assert from "node:assert/strict";
import { QqAccessTokenProvider } from "../src/qq/QqAccessToken.js";

let now = 1_000_000;
let calls = 0;

const fetchImpl: typeof fetch = async (input, init) => {
  calls += 1;
  assert.equal(input, "https://bots.qq.com/app/getAppAccessToken");
  assert.equal(init?.method, "POST");
  assert.deepEqual(JSON.parse(String(init?.body)), {
    appId: "1904411437",
    clientSecret: "secret",
  });

  return new Response(JSON.stringify({ access_token: `access-token-${calls}`, expires_in: "7200" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const provider = new QqAccessTokenProvider({
  appId: "1904411437",
  appSecret: "secret",
  fetchImpl,
  now: () => now,
});

assert.equal(await provider.authorization(), "QQBot access-token-1");
assert.equal(await provider.authorization(), "QQBot access-token-1");
assert.equal(calls, 1);

now += (7200 - 59) * 1000;
assert.equal(await provider.authorization(), "QQBot access-token-2");
assert.equal(calls, 2);

const legacyProvider = new QqAccessTokenProvider({
  appId: "1904411437",
  legacyToken: "legacy-token",
});
assert.equal(await legacyProvider.authorization(), "Bot 1904411437.legacy-token");

console.log("qq access token tests passed");
