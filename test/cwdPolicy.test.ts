import assert from "node:assert/strict";
import path from "node:path";
import { assertCwdAllowed, isCwdAllowed, parseAllowedCwdRoots, renderAllowedCwdRoots } from "../src/core/CwdPolicy.js";

const root = path.resolve("/tmp/acp-root");
const nested = path.join(root, "project");
const sibling = path.resolve("/tmp/acp-root-other");

assert.deepEqual(parseAllowedCwdRoots("projects, /opt/work", "/home/user"), [
  path.resolve("/home/user/projects"),
  path.resolve("/opt/work"),
]);
assert.equal(isCwdAllowed(nested, [root]), true);
assert.equal(isCwdAllowed(root, [root]), true);
assert.equal(isCwdAllowed(sibling, [root]), false);
assert.equal(isCwdAllowed(sibling, []), true);
assert.equal(renderAllowedCwdRoots([]), "unrestricted");
assert.doesNotThrow(() => assertCwdAllowed(nested, [root]));
assert.throws(() => assertCwdAllowed(sibling, [root]), /目录不在允许的工作区范围内/);

console.log("cwd policy tests passed");
