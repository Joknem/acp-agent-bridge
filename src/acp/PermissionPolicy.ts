import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type PermissionMode = "allow_once" | "allow_always" | "deny";

export function permissionDecision(mode: PermissionMode, options: readonly PermissionOption[]): RequestPermissionResponse {
  const option = selectPermissionOption(mode, options);
  if (!option) {
    return { outcome: { outcome: "cancelled" as const } };
  }

  return {
    outcome: {
      outcome: "selected" as const,
      optionId: option.optionId,
    },
  };
}

export function selectPermissionOption(mode: PermissionMode, options: readonly PermissionOption[]) {
  switch (mode) {
    case "allow_always":
      return findOption(options, "allow_always") ?? findOption(options, "allow_once");
    case "deny":
      return findOption(options, "reject_once") ?? findOption(options, "reject_always");
    case "allow_once":
      return findOption(options, "allow_once") ?? findOption(options, "allow_always");
  }
}

function findOption(options: readonly PermissionOption[], kind: PermissionOption["kind"]) {
  return options.find((option) => option.kind === kind);
}
