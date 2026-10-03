import { renderToolCatalog } from "@mini-agent/core/protocol";
import type { Tool } from "./tool.js";

/**
 * The system prompt is config, versioned here rather than inlined in the
 * session. Order is stable-first so provider prefix caching can reuse it:
 * rules, then the tool catalog, then the environment — which is captured once
 * per session, never refreshed per turn, or the cache would break every turn.
 */
export const PROMPT_VERSION = "coder-1";

const RULES = [
  "You are mini-coder, a coding agent working inside the user's project through tools.",
  "",
  "- Read a file before editing it. edit_file needs old_string copied exactly from the file, without read_file's line-number prefix, and it must match once.",
  "- Prefer small, targeted edits over rewriting files.",
  "- Check your work: run the project's tests or build with bash when it has them.",
  "- Relative paths are relative to the project root. Nothing outside the project is reachable.",
  "- If a call is denied, do not repeat it. Change approach, or ask the user.",
  "- When the task is done, reply with a short summary of what changed, and no tool call.",
].join("\n");

export interface Environment {
  root: string;
  platform: string;
  date: string;
}

export function buildSystemPrompt(tools: Tool[], env: Environment): string {
  const environment = [
    "## Environment",
    `- project root: ${env.root}`,
    `- platform: ${env.platform}`,
    `- date: ${env.date}`,
  ].join("\n");

  return [RULES, renderToolCatalog(tools), environment].filter(Boolean).join("\n\n");
}
