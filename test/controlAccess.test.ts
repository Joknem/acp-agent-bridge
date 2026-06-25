import assert from "node:assert/strict";
import { controlDeniedMessage, isControlAllowed, maskControlUsers, parseControlAllowedUsers } from "../src/core/ControlAccess.js";

assert.deepEqual(parseControlAllowedUsers("u1, u2,,u3 "), ["u1", "u2", "u3"]);
assert.equal(isControlAllowed({ policy: "open", allowedUsers: [] }, { senderIds: [] }), true);
assert.equal(isControlAllowed({ policy: "allowlist", allowedUsers: ["u1"] }, { senderIds: ["u2", "u1"] }), true);
assert.equal(isControlAllowed({ policy: "allowlist", allowedUsers: ["u1"] }, { senderIds: ["u2"] }), false);
assert.equal(isControlAllowed({ policy: "allowlist", allowedUsers: [] }, { senderIds: ["u1"] }), false);
assert.deepEqual(maskControlUsers(["short", "very-long-user-id"]), ["short", "very...r-id"]);
assert(controlDeniedMessage({ policy: "allowlist", allowedUsers: ["u1"] }, { senderIds: ["u2"] }).includes("CONTROL_COMMAND_ALLOWED_USERS"));

console.log("control access tests passed");
