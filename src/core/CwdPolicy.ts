import path from "node:path";

export function parseAllowedCwdRoots(value: string, defaultCwd: string) {
  return splitPathList(value).map((item) => path.resolve(defaultCwd, item));
}

export function isCwdAllowed(cwd: string, allowedRoots: readonly string[]) {
  if (!allowedRoots.length) return true;

  const target = normalizePath(cwd);
  return allowedRoots.some((root) => isSameOrInside(target, normalizePath(root)));
}

export function assertCwdAllowed(cwd: string, allowedRoots: readonly string[]) {
  if (isCwdAllowed(cwd, allowedRoots)) return;

  throw new Error(
    [
      `目录不在允许的工作区范围内：${cwd}`,
      `允许范围：${allowedRoots.length ? allowedRoots.join(", ") : "未限制"}`,
      "请调整 ACP_ALLOWED_CWD_ROOTS，或选择允许范围内的目录。",
    ].join("\n"),
  );
}

export function renderAllowedCwdRoots(allowedRoots: readonly string[]) {
  return allowedRoots.length ? allowedRoots.join(", ") : "unrestricted";
}

function splitPathList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePath(value: string) {
  return path.resolve(value);
}

function isSameOrInside(target: string, root: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
