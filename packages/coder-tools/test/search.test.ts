import assert from "node:assert/strict";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readFileTool, writeFileTool } from "../src/files.js";
import { globTool, grepTool } from "../src/search.js";
import { context, tempProject } from "./helpers.js";

async function project(files: Record<string, string | Buffer>) {
  const root = await tempProject();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const tree = {
  "package.json": "{}",
  "src/a.ts": "export const a = 1;\nconst TODO = 'later';\n",
  "src/ui/App.tsx": "// todo: render\nexport function App() {}\n",
  "node_modules/dep/index.ts": "export const TODO = 1;\n",
  ".git/config": "TODO",
  ".env": "TODO=secret",
  "logo.png": Buffer.from([0x89, 0x00, 0x54, 0x4f, 0x44, 0x4f]),
};

test("glob lists matching files, sorted, without .git, node_modules or secrets", async () => {
  const { ctx } = context(await project(tree));

  assert.equal(await globTool.run({ pattern: "**/*.{ts,tsx}" }, ctx), "src/a.ts\nsrc/ui/App.tsx");
  assert.equal(await globTool.run({ pattern: "*" }, ctx), "logo.png\npackage.json");
  assert.equal(await globTool.run({ pattern: "**/*.go" }, ctx), "no files match **/*.go");
});

test("glob caps a long listing and says how many are left", async () => {
  const many = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, ""]));
  const { ctx } = context(await project(many));

  const out = await globTool.run({ pattern: "*.txt" }, ctx);
  assert.equal(out.split("\n").length, 202);
  assert.match(out, /^f000\.txt\n/);
  assert.match(out, /… 5 more\. Narrow the pattern to see them\.$/);
});

test("grep reports path:line:text and skips binaries, node_modules and secrets", async () => {
  const { ctx } = context(await project(tree));

  assert.equal(await grepTool.run({ pattern: "TODO" }, ctx), "src/a.ts:2:const TODO = 'later';");
  assert.equal(
    await grepTool.run({ pattern: "todo", ignore_case: true }, ctx),
    "src/a.ts:2:const TODO = 'later';\nsrc/ui/App.tsx:1:// todo: render",
  );
  assert.equal(await grepTool.run({ pattern: "^export \\w+ (a|App)\\b" }, ctx), "src/a.ts:1:export const a = 1;\nsrc/ui/App.tsx:2:export function App() {}");
  assert.equal(await grepTool.run({ pattern: "nothing here" }, ctx), "no matches for nothing here");
});

test("grep narrows by path and by glob, and refuses what the path guard refuses", async () => {
  const { ctx } = context(await project(tree));

  assert.equal(await grepTool.run({ pattern: "export", path: "src/ui" }, ctx), "src/ui/App.tsx:2:export function App() {}");
  assert.equal(await grepTool.run({ pattern: "export", path: "src/a.ts" }, ctx), "src/a.ts:1:export const a = 1;");
  assert.equal(await grepTool.run({ pattern: "export", glob: "*.tsx" }, ctx), "src/ui/App.tsx:2:export function App() {}");
  assert.equal(await grepTool.run({ pattern: "export", glob: "src/*.ts" }, ctx), "src/a.ts:1:export const a = 1;");

  await assert.rejects(grepTool.run({ pattern: "x", path: ".env" }, ctx), /off limits/);
  await assert.rejects(grepTool.run({ pattern: "x", path: tmpdir() }, ctx), /outside the project/);
  await assert.rejects(grepTool.run({ pattern: "x", path: "missing" }, ctx), /does not exist/);
  await assert.rejects(grepTool.run({ pattern: "(" }, ctx), /invalid regular expression/);
});

test("write_file creates files and folders, checkpoints first, and allows a follow-up write", async () => {
  const root = await project({});
  const { ctx, checkpoints } = context(root);

  assert.equal(await writeFileTool.run({ path: "src/new/a.ts", content: "one\ntwo\n" }, ctx), "created src/new/a.ts (2 lines)");
  assert.equal(await readFile(join(root, "src/new/a.ts"), "utf8"), "one\ntwo\n");
  assert.deepEqual(checkpoints, [join(root, "src/new/a.ts")]);

  // Its own write counts as a read.
  assert.equal(await writeFileTool.run({ path: "src/new/a.ts", content: "" }, ctx), "overwrote src/new/a.ts (0 lines)");
});

test("write_file overwrites only a file that was read and has not changed since", async () => {
  const root = await project({ "a.txt": "old" });
  const { ctx } = context(root);

  await assert.rejects(writeFileTool.run({ path: "a.txt", content: "new" }, ctx), /read it with read_file before overwriting/);

  await readFileTool.run({ path: "a.txt" }, ctx);
  await utimes(join(root, "a.txt"), new Date(), new Date(Date.now() + 5_000));
  await assert.rejects(writeFileTool.run({ path: "a.txt", content: "new" }, ctx), /has changed since you read it/);

  await readFileTool.run({ path: "a.txt" }, ctx);
  assert.equal(await writeFileTool.run({ path: "a.txt", content: "new" }, ctx), "overwrote a.txt (1 line)");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "new");
});

test("write_file cannot leave the project through a symlink, even into a folder that does not exist yet", async () => {
  const root = await project({});
  const outside = await tempProject();
  await symlink(outside, join(root, "link"));
  const { ctx } = context(root);

  await assert.rejects(writeFileTool.run({ path: "link/new/deep/a.txt", content: "x" }, ctx), /outside the project/);
  await assert.rejects(writeFileTool.run({ path: ".env.local", content: "x" }, ctx), /off limits/);
  await assert.rejects(writeFileTool.run({ path: "link", content: "x" }, ctx), /outside the project/);
});
