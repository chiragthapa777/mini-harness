import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, matchesGlob, relative } from "node:path";
import type { Tool } from "@mini-agent/coder-core";
import { z } from "zod";
import { isOffLimits, resolveInProject } from "./paths.js";

const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);
const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;

/**
 * Every file under `folder`, as paths relative to the project root. Symlinks
 * are not followed, so the walk cannot leave the project.
 * ponytail: skips only .git and node_modules; it does not read .gitignore, so
 * build output is listed too. Upgrade: `rg --files`, or `git ls-files`.
 */
async function* walk(root: string, folder: string, signal: AbortSignal): AsyncGenerator<string> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal.throwIfAborted();
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) yield* walk(root, path, signal);
    } else if (entry.isFile() && !isOffLimits(root, path)) {
      yield relative(root, path);
    }
  }
}

/** Joins the first results and says how many were left out. */
function listing(results: string[], total: number, none: string): string {
  if (total === 0) return none;
  const more = total - results.length;
  return results.join("\n") + (more > 0 ? `\n\n… ${more} more. Narrow the pattern to see them.` : "");
}

const globSchema = z.object({
  pattern: z.string().min(1).describe("Glob relative to the project root, e.g. `src/**/*.ts` or `**/package.json`"),
});

export const globTool: Tool<typeof globSchema> = {
  name: "glob",
  description:
    "List the project's files whose path matches a glob. `*` stays inside one folder; use `**/` " +
    "to match at any depth. Folders starting with a dot must be named explicitly. " +
    ".git and node_modules are never listed.",
  kind: "read",
  schema: globSchema,
  async run({ pattern }, ctx) {
    const found: string[] = [];
    for await (const file of walk(ctx.root, ctx.root, ctx.signal)) {
      if (matchesGlob(file, pattern)) found.push(file);
    }
    return listing(found.slice(0, MAX_RESULTS), found.length, `no files match ${pattern}`);
  },
};

const grepSchema = z.object({
  pattern: z.string().min(1).describe("A JavaScript regular expression, matched line by line"),
  path: z.string().min(1).optional().describe("File or folder to search (default: the whole project)"),
  glob: z.string().min(1).optional().describe("Only search files matching this glob, e.g. `*.ts` or `src/**/*.tsx`"),
  ignore_case: z.boolean().optional(),
});

export const grepTool: Tool<typeof grepSchema> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Results are `path:line:text`. " +
    "Binary files, files over 1 MB, .git and node_modules are skipped.",
  kind: "read",
  schema: grepSchema,
  // ponytail: plain Node, one file at a time, and the regex runs on the event
  // loop, so a huge tree or a pathological pattern stalls the UI. Upgrade: spawn rg.
  async run({ pattern, path = ".", glob, ignore_case = false }, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err) {
      throw new Error(`invalid regular expression: ${(err as Error).message}`);
    }

    const start = await resolveInProject(ctx.root, path);
    const info = await stat(start).catch(() => null);
    if (!info) throw new Error(`${path} does not exist`);
    const files = info.isFile() ? [relative(ctx.root, start)] : walk(ctx.root, start, ctx.signal);

    const matches: string[] = [];
    let total = 0;
    for await (const file of files) {
      // A glob without a folder matches the file name, like `*.ts`.
      if (glob && !matchesGlob(glob.includes("/") ? file : basename(file), glob)) continue;

      const bytes = await readFile(join(ctx.root, file)).catch(() => null);
      if (!bytes || bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 8_000).includes(0)) continue;

      bytes
        .toString("utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (!regex.test(line)) return;
          total++;
          if (matches.length < MAX_RESULTS) matches.push(`${file}:${index + 1}:${line.slice(0, MAX_LINE_CHARS)}`);
        });
    }
    return listing(matches, total, `no matches for ${pattern}`);
  },
};
