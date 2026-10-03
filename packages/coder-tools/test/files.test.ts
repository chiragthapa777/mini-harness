import assert from "node:assert/strict";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { editFileTool, readFileTool } from "../src/files.js";
import { context, tempProject } from "./helpers.js";

async function project(files: Record<string, string | Buffer>) {
  const root = await tempProject();
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

test("read_file numbers lines and records the mtime", async () => {
  const root = await project({ "a.ts": "one\ntwo\nthree\n" });
  const { ctx } = context(root);

  const out = await readFileTool.run({ path: "a.ts" }, ctx);
  assert.equal(out, "     1\tone\n     2\ttwo\n     3\tthree");
  assert.ok(ctx.reads.has(join(root, "a.ts")));
});

test("read_file pages with offset and limit, and says how to continue", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const root = await project({ "long.txt": lines });
  const { ctx } = context(root);

  const out = await readFileTool.run({ path: "long.txt", offset: 4, limit: 3 }, ctx);
  assert.equal(
    out,
    "     4\tline 4\n     5\tline 5\n     6\tline 6\n\n… 4 more lines. Call read_file with offset 7 to continue.",
  );
  assert.match(await readFileTool.run({ path: "long.txt", offset: 50 }, ctx), /past the end: long.txt has 10 lines/);
});

test("read_file refuses binaries, directories and missing files; clips huge lines", async () => {
  const root = await project({
    "img.png": Buffer.from([0x89, 0x50, 0x00, 0x47]),
    "empty.txt": "",
    "wide.txt": "x".repeat(5_000),
  });
  const { ctx } = context(root);

  await assert.rejects(readFileTool.run({ path: "img.png" }, ctx), /binary file/);
  await assert.rejects(readFileTool.run({ path: "." }, ctx), /is a directory/);
  await assert.rejects(readFileTool.run({ path: "nope.txt" }, ctx), /does not exist/);
  assert.equal(await readFileTool.run({ path: "empty.txt" }, ctx), "(empty file)");
  assert.match(await readFileTool.run({ path: "wide.txt" }, ctx), /x{2000}… \[line truncated\]$/);
});

test("edit_file requires a prior read, and an unchanged file", async () => {
  const root = await project({ "a.ts": "const a = 1;\n" });
  const { ctx } = context(root);
  const edit = { path: "a.ts", old_string: "1", new_string: "2" };

  await assert.rejects(editFileTool.run(edit, ctx), /read a.ts with read_file before editing it/);

  await readFileTool.run({ path: "a.ts" }, ctx);
  // Someone else touches the file after the read.
  const later = new Date(Date.now() + 5_000);
  await utimes(join(root, "a.ts"), later, later);
  await assert.rejects(editFileTool.run(edit, ctx), /has changed since you read it/);
});

test("edit_file replaces one exact match, checkpoints first, and allows a follow-up edit", async () => {
  const root = await project({ "a.ts": "const a = 1;\nconst b = 2;\n" });
  const { ctx, checkpoints } = context(root);
  await readFileTool.run({ path: "a.ts" }, ctx);

  const out = await editFileTool.run({ path: "a.ts", old_string: "a = 1", new_string: "a = 10" }, ctx);
  assert.equal(out, "edited a.ts (1 replacement)");
  assert.deepEqual(checkpoints, [join(root, "a.ts")]);

  // No re-read needed after our own edit.
  await editFileTool.run({ path: "a.ts", old_string: "b = 2", new_string: "b = 20" }, ctx);
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "const a = 10;\nconst b = 20;\n");
});

test("edit_file refuses missing, ambiguous and no-op edits", async () => {
  const root = await project({ "a.ts": "x\nx\n" });
  const { ctx } = context(root);
  await readFileTool.run({ path: "a.ts" }, ctx);

  await assert.rejects(editFileTool.run({ path: "a.ts", old_string: "y", new_string: "z" }, ctx), /was not found/);
  await assert.rejects(editFileTool.run({ path: "a.ts", old_string: "x", new_string: "z" }, ctx), /matches 2 times/);
  await assert.rejects(editFileTool.run({ path: "a.ts", old_string: "x", new_string: "x" }, ctx), /identical/);
  await assert.rejects(editFileTool.run({ path: "a.ts", old_string: "", new_string: "z" }, ctx), /empty/);
  await assert.rejects(
    editFileTool.run({ path: "missing.ts", old_string: "a", new_string: "b" }, ctx),
    /only changes existing files/,
  );

  const out = await editFileTool.run({ path: "a.ts", old_string: "x", new_string: "z", replace_all: true }, ctx);
  assert.equal(out, "edited a.ts (2 replacements)");
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "z\nz\n");
});

test("edit_file treats $ patterns in new_string literally", async () => {
  const root = await project({ "a.ts": "price = X\n" });
  const { ctx } = context(root);
  await readFileTool.run({ path: "a.ts" }, ctx);
  await editFileTool.run({ path: "a.ts", old_string: "X", new_string: "$& $1 $$" }, ctx);
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "price = $& $1 $$\n");
});

test("file tools go through the path guard", async () => {
  const root = await project({ ".env": "SECRET=1" });
  const { ctx } = context(root);
  await assert.rejects(readFileTool.run({ path: ".env" }, ctx), /off limits/);
  await assert.rejects(readFileTool.run({ path: "../../etc/passwd" }, ctx), /outside the project/);
});
