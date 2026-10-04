import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Tool } from "./tool.js";

/**
 * What outlives a session, as plain files (see docs/mini-coder-memory.md).
 * `home` is `~/.mini-coder`; `root` is the project, already resolved.
 *
 *   <home>/AGENTS.md, <root>/AGENTS.md                   rules, written by people
 *   <home>/MEMORY.md, <home>/projects/<slug>/MEMORY.md   facts, one per line
 *   <home>/skills/<name>/SKILL.md, <root>/.mini-coder/skills/<name>/SKILL.md
 */

const MAX_FILE_CHARS = 20_000;
const MAX_FACT_CHARS = 500;

interface Skill {
  name: string;
  description: string;
  file: string;
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(0, MAX_FILE_CHARS).trim();
  } catch {
    return "";
  }
}

function factsFile(home: string, root: string, scope: "user" | "project"): string {
  // The project's facts live outside the repository, under a folder named after its path.
  return scope === "user" ? join(home, "MEMORY.md") : join(home, "projects", root.replaceAll("/", "-"), "MEMORY.md");
}

/** Skills by name: the folder is the name, `description:` in the file's front matter says when to use it. */
function findSkills(folder: string): Skill[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(folder, name, "SKILL.md");
    const description = /^description:\s*(.+)$/m.exec(read(file))?.[1]?.trim();
    return description ? [{ name, description, file }] : [];
  });
}

/**
 * Loads memory once, at session start: the text for the system prompt, and
 * the two tools that reach it. Nothing is re-read during the session, so the
 * prompt stays the same and the provider's cache keeps working.
 */
export function loadMemory(home: string, root: string): { prompt: string; tools: Tool[] } {
  // A project skill replaces a personal one with the same name.
  const skills = new Map<string, Skill>();
  for (const skill of [...findSkills(join(home, "skills")), ...findSkills(join(root, ".mini-coder", "skills"))]) {
    skills.set(skill.name, skill);
  }

  const section = (title: string, ...parts: string[]) => {
    const body = parts.filter(Boolean).join("\n\n");
    return body ? `## ${title}\n${body}` : "";
  };
  const prompt = [
    section("Instructions from the user (AGENTS.md)", read(join(home, "AGENTS.md")), read(join(root, "AGENTS.md"))),
    section(
      "Remembered facts",
      read(factsFile(home, root, "user")),
      read(factsFile(home, root, "project")),
    ),
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
      return read(skill.file);
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
      const file = factsFile(home, root, scope);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `- ${fact.replace(/\s+/g, " ").trim()}\n`);
      return `remembered for ${scope === "user" ? "every project" : "this project"}`;
    },
  };

  return { prompt, tools: skills.size > 0 ? [skillTool, rememberTool] : [rememberTool] };
}
