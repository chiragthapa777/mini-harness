import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "@mini-agent/coder-core";
import { z } from "zod";
import { display, resolveInProject } from "./paths.js";

const DEFAULT_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;

const readSchema = z.object({
  path: z.string().min(1).describe("File path, relative to the project root or absolute"),
  offset: z.number().int().min(1).optional().describe("First line to read, 1-based (default 1)"),
  limit: z.number().int().min(1).optional().describe(`How many lines (default ${DEFAULT_LINES})`),
});

export const readFileTool: Tool<typeof readSchema> = {
  name: "read_file",
  description:
    "Read a text file. Lines come back numbered like `cat -n` (number, tab, text); " +
    "the numbers are not part of the file. Use offset and limit for long files. " +
    "A file must be read before edit_file can change it.",
  kind: "read",
  schema: readSchema,
  async run({ path, offset = 1, limit = DEFAULT_LINES }, ctx) {
    const real = await resolveInProject(ctx.root, path);
    const info = await stat(real).catch(() => null);
    if (!info) throw new Error(`${path} does not exist`);
    if (info.isDirectory()) throw new Error(`${path} is a directory; list it with glob instead`);

    const bytes = await readFile(real);
    // A NUL byte in the first 8 KB is the same heuristic git uses for binary.
    if (bytes.subarray(0, 8_000).includes(0)) {
      throw new Error(`${path} is a binary file (${bytes.length} bytes) and cannot be shown`);
    }
    ctx.reads.set(real, info.mtimeMs);

    const text = bytes.toString("utf8");
    if (!text) return "(empty file)";

    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (offset > lines.length) {
      return `(offset ${offset} is past the end: ${display(ctx.root, real)} has ${lines.length} lines)`;
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((line, index) => {
        const clipped =
          line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(offset + index).padStart(6)}\t${clipped}`;
      })
      .join("\n");

    const next = offset + slice.length;
    const remaining = lines.length - next + 1;
    return remaining > 0
      ? `${body}\n\n… ${remaining} more lines. Call read_file with offset ${next} to continue.`
      : body;
  },
};

const editSchema = z.object({
  path: z.string().min(1).describe("File to change; it must already exist and have been read"),
  old_string: z.string().describe("Exact text to replace, copied from the file without line numbers"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one"),
});

export const editFileTool: Tool<typeof editSchema> = {
  name: "edit_file",
  description:
    "Replace text in an existing file. old_string must match the file exactly, " +
    "whitespace and indentation included, and must be unique unless replace_all is set — " +
    "include surrounding lines to make it unique. The file must have been read with " +
    "read_file first and not changed since.",
  kind: "write",
  schema: editSchema,
  async run({ path, old_string, new_string, replace_all = false }, ctx) {
    const real = await resolveInProject(ctx.root, path);
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) throw new Error(`${path} does not exist; create it with write_file`);

    const readAt = ctx.reads.get(real);
    if (readAt === undefined) throw new Error(`read ${path} with read_file before editing it`);
    if (info.mtimeMs !== readAt) {
      throw new Error(`${path} has changed since you read it; read it again before editing`);
    }
    if (!old_string) throw new Error("old_string is empty");
    if (old_string === new_string) throw new Error("old_string and new_string are identical");

    const content = await readFile(real, "utf8");
    const count = content.split(old_string).length - 1;
    if (count === 0) {
      throw new Error(
        `old_string was not found in ${path}. It must match exactly, including whitespace and indentation.`,
      );
    }
    if (count > 1 && !replace_all) {
      throw new Error(
        `old_string matches ${count} times in ${path}. Include more surrounding lines to make it unique, or set replace_all.`,
      );
    }

    // A function as the replacement keeps `$&` and `$1` in new_string literal.
    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, () => new_string);

    await ctx.checkpoint(real);
    await writeFile(real, updated);
    // Our own write is not "changed since read": keep the next edit possible.
    ctx.reads.set(real, (await stat(real)).mtimeMs);

    const replaced = replace_all ? count : 1;
    return `edited ${display(ctx.root, real)} (${replaced} replacement${replaced === 1 ? "" : "s"})`;
  },
};

const writeSchema = z.object({
  path: z.string().min(1).describe("File to create or overwrite; missing folders are created"),
  content: z.string().describe("The whole new content of the file"),
});

export const writeFileTool: Tool<typeof writeSchema> = {
  name: "write_file",
  description:
    "Create a file, or replace the whole content of an existing one. An existing file must " +
    "have been read with read_file first and not changed since. To change part of a file, use edit_file.",
  kind: "write",
  schema: writeSchema,
  async run({ path, content }, ctx) {
    const real = await resolveInProject(ctx.root, path);
    const info = await stat(real).catch(() => null);
    if (info && !info.isFile()) throw new Error(`${path} is not a file`);
    if (info) {
      const readAt = ctx.reads.get(real);
      if (readAt === undefined) throw new Error(`${path} already exists; read it with read_file before overwriting it`);
      if (info.mtimeMs !== readAt) {
        throw new Error(`${path} has changed since you read it; read it again before overwriting it`);
      }
    }

    await ctx.checkpoint(real);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content);
    ctx.reads.set(real, (await stat(real)).mtimeMs);

    const lines = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
    return `${info ? "overwrote" : "created"} ${display(ctx.root, real)} (${lines} line${lines === 1 ? "" : "s"})`;
  },
};
