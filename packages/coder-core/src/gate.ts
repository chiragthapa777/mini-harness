import type { PermissionMode } from "@mini-agent/coder-protocol";
import type { Tool } from "./tool.js";

/**
 * The one place a tool call is allowed, denied, or sent to the user.
 *
 * Phase 2 is a stub: the decision depends on the tool's kind and the mode
 * only. Rules (`Bash(npm test:*)`), deny lists and bash parsing come in
 * phase 5 behind this same interface.
 */
export type Verdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason: string };

export interface PermissionGate {
  check(tool: Tool, input: unknown): Verdict;
}

export function modeGate(mode: PermissionMode): PermissionGate {
  return {
    check(tool) {
      if (tool.kind === "read" || mode === "bypass") return { decision: "allow" };

      switch (mode) {
        case "plan":
          return { decision: "deny", reason: "plan mode is read-only" };
        case "accept-edits":
          return tool.kind === "write"
            ? { decision: "allow" }
            : { decision: "ask", reason: `${tool.name} runs commands, which always ask outside bypass mode` };
        case "default":
          return {
            decision: "ask",
            reason: tool.kind === "write" ? "file changes ask by default" : "commands ask by default",
          };
      }
    },
  };
}

/**
 * What an "always" answer covers for the rest of the session. A file tool is
 * trusted as a whole once approved; a command only verbatim, because "always
 * allow bash" after approving `npm test` would also allow `rm -rf`.
 */
export function alwaysKey(tool: Tool, input: unknown): string {
  return tool.kind === "exec" ? `${tool.name}:${JSON.stringify(input)}` : tool.name;
}
