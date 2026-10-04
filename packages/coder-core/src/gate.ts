import type { PermissionMode } from "./wire.js";
import type { Tool } from "./tool.js";

export type Verdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason: string };

/**
 * A rule names a tool, and for a command tool optionally which commands:
 * `edit_file`, `bash(npm test)` (exactly that), `bash(npm test:*)` (that, or
 * that followed by arguments).
 */
export interface Rule {
  tool: string;
  command?: string;
  prefix?: boolean;
}

export interface Rules {
  allow: Rule[];
  deny: Rule[];
}

export function parseRule(text: string): Rule {
  const match = /^([\w-]+)(?:\((.+)\))?$/.exec(text.trim());
  if (!match) throw new Error(`not a rule: "${text}". Expected tool, tool(command) or tool(command:*)`);
  const [, tool = "", command] = match;
  if (command === undefined) return { tool };
  return command.endsWith(":*") ? { tool, command: command.slice(0, -2).trim(), prefix: true } : { tool, command };
}

/**
 * Commands refused in every mode, bypass included. Matched against the whole
 * command text, so quoting does not hide them.
 * ponytail: a pattern list, not a sandbox. `bash -c "$(echo cm0gLXJmIC8= | base64 -d)"`
 * gets through. The `sandbox` setting is what confines bash for real.
 */
const BLOCKED: [RegExp, string][] = [
  [/\bsudo\b/, "sudo"],
  [/\brm\s+(-[\w-]+\s+)*(\/|~|\$HOME)\/?(\s|$)/, "deleting / or the home folder"],
  [/\b(mkfs|fdisk)\b|\bdd\b.*\bof=\/dev\//, "writing to a disk device"],
  [/\b(curl|wget)\b.*\|\s*(ba|z)?sh\b/, "piping a download into a shell"],
  [/:\(\)\s*\{.*\};\s*:/, "a fork bomb"],
  [/(^|[\s/"'=])\.env(?!\.example)(\.[\w.-]+)?(\s|$|["';|&)])/, "reading or changing a .env file"],
  [/(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.ssh\b/, "touching ~/.ssh"],
  [/\.mini-coder\/settings(\.local)?\.json/, "touching mini-coder's settings"],
];

/**
 * Splits a command line into the commands it runs, on `;`, `&`, `&&`, `||`,
 * `|` and line breaks outside quotes. Returns null when it cannot tell what
 * runs: command substitution, redirection, subshells, an open quote.
 * ponytail: null is the safe answer, so `npm test 2>&1` is never covered by a
 * prefix rule. Upgrade: a real shell parser.
 */
export function splitCommand(command: string): string[] | null {
  const parts: string[] = [];
  let part = "";
  let quote = "";

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = "";
    } else if (char === "\\") {
      part += char + (command[++i] ?? "");
      continue;
    } else if (char === "`" || (char === "$" && command[i + 1] === "(")) {
      return null;
    } else if (quote === '"') {
      if (char === '"') quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if ("<>(){}".includes(char)) {
      return null;
    } else if (";&|\n".includes(char)) {
      parts.push(part);
      part = "";
      continue;
    }
    part += char;
  }

  if (quote) return null;
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function matches(rule: Rule, tool: Tool, command: string | undefined): boolean {
  if (rule.tool !== tool.name) return false;
  if (rule.command === undefined) return true;
  if (command === undefined) return false;
  return command === rule.command || (rule.prefix === true && command.startsWith(rule.command + " "));
}

/** The shell command a call runs, when it is a command tool. */
function commandOf(tool: Tool, input: unknown): string | undefined {
  const command = tool.kind === "exec" ? (input as { command?: unknown } | null)?.command : undefined;
  return typeof command === "string" ? command.trim() : undefined;
}

/**
 * Decides whether a tool call may run. In order: the block list and deny
 * rules refuse in every mode; reads run; then the mode; then allow rules;
 * otherwise writes and commands ask.
 */
export function checkPermission(mode: PermissionMode, tool: Tool, input: unknown, rules: Rules): Verdict {
  const command = commandOf(tool, input);
  const parts = command === undefined ? null : splitCommand(command);

  const blocked = BLOCKED.find(([pattern]) => command !== undefined && pattern.test(command));
  if (blocked) return { decision: "deny", reason: `blocked: ${blocked[1]}` };
  // One denied command in a compound line denies the line.
  if (rules.deny.some((rule) => [command, ...(parts ?? [])].some((part) => matches(rule, tool, part)))) {
    return { decision: "deny", reason: "denied by a rule" };
  }

  if (tool.kind === "read" || mode === "bypass") return { decision: "allow" };
  if (mode === "plan") return { decision: "deny", reason: "plan mode is read-only" };

  // The whole line may only match exactly: `npm test:*` must not cover
  // `npm test && rm -rf build`. Otherwise every command in it needs a rule.
  const wholeAllowed = rules.allow.some((rule) => !rule.prefix && matches(rule, tool, command));
  const eachAllowed =
    parts !== null && parts.length > 0 && parts.every((part) => rules.allow.some((rule) => matches(rule, tool, part)));
  if (wholeAllowed || eachAllowed) return { decision: "allow" };

  if (mode === "accept-edits" && tool.kind === "write") return { decision: "allow" };
  return { decision: "ask", reason: tool.kind === "write" ? "file changes ask first" : "commands ask first" };
}

/**
 * The rule an "always" answer adds: a file tool as a whole, but a command only
 * verbatim — approving `npm test` must not approve `rm -rf`.
 */
export function alwaysRule(tool: Tool, input: unknown): Rule {
  const command = commandOf(tool, input);
  return command === undefined ? { tool: tool.name } : { tool: tool.name, command };
}
