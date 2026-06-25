import assert from "node:assert/strict";
import { permissionDecision, selectPermissionOption } from "../src/acp/PermissionPolicy.js";

const options = [
  { kind: "allow_always" as const, name: "Allow always", optionId: "always" },
  { kind: "allow_once" as const, name: "Allow once", optionId: "once" },
  { kind: "reject_once" as const, name: "Reject once", optionId: "reject" },
];

assert.equal(selectPermissionOption("allow_once", options)?.optionId, "once");
assert.equal(selectPermissionOption("allow_always", options)?.optionId, "always");
assert.equal(selectPermissionOption("deny", options)?.optionId, "reject");

assert.deepEqual(permissionDecision("allow_once", options), {
  outcome: {
    outcome: "selected",
    optionId: "once",
  },
});

assert.deepEqual(permissionDecision("deny", options.filter((option) => option.kind !== "reject_once")), {
  outcome: {
    outcome: "cancelled",
  },
});

console.log("permission policy tests passed");
