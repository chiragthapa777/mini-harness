import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { bashTool } from "../src/bash.js";
import { context, tempProject } from "./helpers.js";

test("runs a command, streams its output, and returns it", async () => {
  const root = await tempProject();
  const { ctx, output } = context(root);

  const out = await bashTool.run({ command: "echo hello; echo oops >&2" }, ctx);
  assert.equal(out, "hello\noops\n");
  assert.equal(output.join(""), "hello\noops\n");
});

test("a non-zero exit is reported, not thrown", async () => {
  const root = await tempProject();
  const { ctx } = context(root);
  assert.equal(await bashTool.run({ command: "echo failing; exit 3" }, ctx), "failing\n\n[exit code 3]");
  assert.equal(await bashTool.run({ command: "true" }, ctx), "(no output)");
});

test("cd persists between calls, and cannot leave the project", async () => {
  const root = await tempProject();
  await mkdir(join(root, "pkg"));
  const { ctx } = context(root);

  await bashTool.run({ command: "cd pkg" }, ctx);
  assert.equal(ctx.shell.cwd, join(root, "pkg"));
  assert.equal(await bashTool.run({ command: "pwd" }, ctx), `${join(root, "pkg")}\n`);

  const out = await bashTool.run({ command: "cd /tmp" }, ctx);
  assert.match(out, /working directory left the project; it was reset/);
  assert.equal(ctx.shell.cwd, root);
});

test("a timeout kills the whole process group", async () => {
  const root = await tempProject();
  const { ctx } = context(root);
  const started = Date.now();

  // The sleep runs in a subshell: killing only bash would leave it running
  // and holding the pipes open.
  await assert.rejects(
    bashTool.run({ command: "echo start; (sleep 30); echo never", timeout: 1_000 }, ctx),
    /start\n\n\[timed out after 1s; the command was killed\]/,
  );
  assert.ok(Date.now() - started < 5_000, "returned promptly");
});

test("aborting stops the command and rejects with the signal's reason", async () => {
  const root = await tempProject();
  const controller = new AbortController();
  const { ctx } = context(root, { signal: controller.signal });

  const running = bashTool.run({ command: "sleep 30" }, ctx);
  setTimeout(() => controller.abort(new Error("Esc")), 200);
  const started = Date.now();
  await assert.rejects(running, { message: "Esc" });
  assert.ok(Date.now() - started < 3_000);
});

test("a background process does not hold the call open", async () => {
  const root = await tempProject();
  const { ctx } = context(root);
  const started = Date.now();
  const out = await bashTool.run({ command: "sleep 30 & echo started" }, ctx);
  assert.equal(out, "started\n");
  assert.ok(Date.now() - started < 3_000);
});

test("stdin is closed, so a command waiting for input ends", async () => {
  const root = await tempProject();
  const { ctx } = context(root);
  assert.equal(await bashTool.run({ command: "read line; echo got:$line" }, ctx), "got:\n");
});

test("multi-byte characters survive chunk boundaries", async () => {
  const root = await tempProject();
  const { ctx } = context(root);
  // 3-byte characters, written one byte at a time: every boundary splits one.
  const out = await bashTool.run({ command: "printf '\\xe2\\x9c\\x93'; printf '\\xe2'; sleep 0.05; printf '\\x9c\\x93\\n'" }, ctx);
  assert.equal(out, "✓✓\n");
});
