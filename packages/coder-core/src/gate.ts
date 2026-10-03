import type { PermissionMode } from "@mini-agent/coder-protocol";
import type { Tool } from "./tool.js";

export type Verdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason: string };

/**
 * Decides whether a tool call may run. For now it looks only at the tool's
 * kind and the mode; rules like `Bash(npm test:*)` come in phase 5.
 */
export function checkPermission(mode: PermissionMode, tool: Tool): Verdict {
  if (tool.kind === "read" || mode === "bypass") return { decision: "allow" };
  if (mode === "plan") return { decision: "deny", reason: "plan mode is read-only" };
  if (mode === "accept-edits" && tool.kind === "write") return { decision: "allow" };
  return { decision: "ask", reason: tool.kind === "write" ? "file changes ask first" : "commands ask first" };
}

/**
 * What an "always" answer covers: a file tool as a whole, but a command only
 * verbatim — approving `npm test` must not approve `rm -rf`.
 */
export function alwaysKey(tool: Tool, input: unknown): string {
  return tool.kind === "exec" ? `${tool.name}:${JSON.stringify(input)}` : tool.name;
}
