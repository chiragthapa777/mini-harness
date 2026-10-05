import { z } from "zod";
import { recallTool } from "./sessions.js";
import type { Store } from "./store.js";
import type { Tool } from "./tool.js";
import type { Listed } from "./wire.js";

/**
 * Memory for the prompt and the tools that reach it: rules (AGENTS.md),
 * facts (MEMORY.md), skills and earlier sessions. Where each one is kept is
 * the store's business (store.ts); this file decides what goes in the prompt.
 */

const MAX_FILE_CHARS = 20_000;
const MAX_FACT_CHARS = 500;

interface Skill {
  name: string;
  description: string;
  text: string;
}

const clip = (text: string) => text.slice(0, MAX_FILE_CHARS).trim();

/**
 * Loads memory once, at session start: the text for the system prompt, and
 * the tools that reach it. Nothing is re-read during the session, so the
 * prompt stays the same and the provider's cache keeps working.
 */
export function loadMemory(store: Store): { prompt: string; tools: Tool[]; skills: Listed[] } {
  // `description:` in a skill's front matter says when to use it; one without is skipped.
  // The store lists the user's skills first, so a project skill replaces a personal one of the same name.
  const skills = new Map<string, Skill>();
  for (const { name, text } of store.readSkills()) {
    const description = /^description:\s*(.+)$/m.exec(clip(text))?.[1]?.trim();
    if (description) skills.set(name, { name, description, text: clip(text) });
  }

  const section = (title: string, ...parts: string[]) => {
    const body = parts.filter(Boolean).join("\n\n");
    return body ? `## ${title}\n${body}` : "";
  };
  const prompt = [
    section("Instructions from the user (AGENTS.md)", ...store.readRules().map(clip)),
    section("Remembered facts", clip(store.readFacts("user")), clip(store.readFacts("project"))),
    section(
      "Skills",
      skills.size > 0 ? "Before a task one of these covers, load it with the skill tool and follow it." : "",
      [...skills.values()].map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const skillSchema = z.object({ name: z.string().min(1) });
  const skillTool: Tool<typeof skillSchema> = {
    name: "skill",
    description: "Load a skill's full instructions by its name from the Skills list.",
    kind: "read",
    schema: skillSchema,
    async run({ name }) {
      const skill = skills.get(name);
      if (!skill) throw new Error(`no skill named "${name}". Known: ${[...skills.keys()].join(", ") || "none"}`);
      return skill.text;
    },
  };

  const rememberSchema = z.object({
    fact: z.string().min(1).max(MAX_FACT_CHARS).describe("One short, lasting fact, as a single sentence"),
    scope: z.enum(["user", "project"]).describe("user: true in every project. project: only about this one"),
  });
  const rememberTool: Tool<typeof rememberSchema> = {
    name: "remember",
    description:
      "Save a fact for future sessions, when the user asks you to remember something or states a lasting " +
      "preference. Not for what the code or git history already shows. It takes effect from the next session.",
    kind: "write",
    schema: rememberSchema,
    // ponytail: the file only grows. Upgrade: past ~200 lines, merge duplicates
    // and drop stale lines with a cheap model call at session end.
    async run({ fact, scope }) {
      await store.appendFact(scope, fact.replace(/\s+/g, " ").trim());
      return `remembered for ${scope === "user" ? "every project" : "this project"}`;
    },
  };

  const recall = recallTool(() => store.sessionLogs());
  return {
    prompt,
    tools: skills.size > 0 ? [skillTool, rememberTool, recall] : [rememberTool, recall],
    skills: [...skills.values()].map(({ name, description }) => ({ name, description })),
  };
}
