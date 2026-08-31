import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SKILLS_DIR = process.env.SKILLS_DIR ?? "skills";

/**
 * Procedural memory — how to act. Plain files (`skills.md`, workflows, rules
 * and guardrails), loaded straight into working memory with no search step.
 */
export async function loadProcedural(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return [];
  }

  const files = entries.filter((name) => name.endsWith(".md"));
  return Promise.all(files.map((name) => readFile(join(SKILLS_DIR, name), "utf8")));
}
