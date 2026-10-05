import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

test("only the store touches mini-coder's own files", async () => {
  // Who else may use the file system, and for what. Nothing here writes under ~/.mini-coder.
  const others: Record<string, string> = {
    "checkpoints.ts": "the project's files, for /undo",
    "session.ts": "checking the project folder exists",
  };

  for (const file of await readdir(srcDir)) {
    const source = await readFile(join(srcDir, file), "utf8");
    if (file === "store.ts" || !/from "node:fs(\/promises)?"/.test(source)) continue;
    assert.ok(file in others, `${file} uses the file system: go through store.ts`);
  }
});
