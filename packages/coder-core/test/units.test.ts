import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Checkpoints } from "../src/checkpoints.js";
import { alwaysKey, checkPermission } from "../src/gate.js";
import { capOutput } from "../src/loop.js";
import { formatModel, parseModel } from "../src/model.js";
import { buildSystemPrompt } from "../src/prompt.js";
import type { Tool, ToolKind } from "../src/tool.js";
import { echoTool, tempProject } from "./helpers.js";

const tool = (kind: ToolKind): Tool => ({ ...echoTool, name: kind, kind });

test("the gate decides by tool kind and mode", () => {
  const table: [string, ToolKind, string][] = [
    ["default", "read", "allow"],
    ["default", "write", "ask"],
    ["default", "exec", "ask"],
    ["accept-edits", "read", "allow"],
    ["accept-edits", "write", "allow"],
    ["accept-edits", "exec", "ask"],
    ["plan", "read", "allow"],
    ["plan", "write", "deny"],
    ["plan", "exec", "deny"],
    ["bypass", "read", "allow"],
    ["bypass", "write", "allow"],
    ["bypass", "exec", "allow"],
  ];

  for (const [mode, kind, expected] of table) {
    const verdict = checkPermission(mode as never, tool(kind));
    assert.equal(verdict.decision, expected, `${mode} / ${kind}`);
  }
});

test("always covers a file tool as a whole, a command only verbatim", () => {
  assert.equal(alwaysKey(tool("write"), { path: "a" }), alwaysKey(tool("write"), { path: "b" }));
  assert.notEqual(
    alwaysKey(tool("exec"), { command: "npm test" }),
    alwaysKey(tool("exec"), { command: "npm test && rm -rf ~" }),
  );
});

test("checkpoints keep the first version per turn and undo turn by turn", async () => {
  const dir = await tempProject();
  const a = join(dir, "a.txt");
  const created = join(dir, "created.txt");
  await writeFile(a, "v0");
  const checkpoints = new Checkpoints();

  checkpoints.begin(); // turn 1
  await checkpoints.save(a);
  await writeFile(a, "v1");
  await checkpoints.save(a); // second save in the same turn keeps v0
  await writeFile(a, "v2");

  checkpoints.begin(); // turn 2: no file changes
  checkpoints.begin(); // turn 3
  await checkpoints.save(a);
  await writeFile(a, "v3");
  await checkpoints.save(created);
  await writeFile(created, "new");

  assert.deepEqual(await checkpoints.undo(), [a, created]);
  assert.equal(await readFile(a, "utf8"), "v2");
  await assert.rejects(readFile(created), { code: "ENOENT" });

  // Turn 2 changed nothing, so the next undo reaches turn 1.
  assert.deepEqual(await checkpoints.undo(), [a]);
  assert.equal(await readFile(a, "utf8"), "v0");
  assert.deepEqual(await checkpoints.undo(), []);
});

test("models are provider:model, split on the first colon", () => {
  assert.deepEqual(parseModel("openrouter:z-ai/glm-5.3-flash"), {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
  });
  assert.deepEqual(parseModel("openai:ft:gpt-4o:acme"), { provider: "openai", model: "ft:gpt-4o:acme" });
  assert.equal(formatModel(parseModel("google:gemini-2.5-pro")), "google:gemini-2.5-pro");

  for (const bad of ["claude", ":model", "anthropic:", "acme:gpt"]) {
    assert.throws(() => parseModel(bad), Error, bad);
  }
});

test("long tool output keeps its head and tail", () => {
  assert.equal(capOutput("short", 100), "short");
  const capped = capOutput(`${"a".repeat(500)}${"z".repeat(500)}`, 100);
  assert.ok(capped.startsWith("a".repeat(50)));
  assert.ok(capped.endsWith("z".repeat(50)));
  assert.match(capped, /\[… 900 characters omitted …\]/);
});

test("the system prompt is stable-first: rules, tools, then environment", () => {
  const prompt = buildSystemPrompt([echoTool], {
    root: "/work/app",
    platform: "linux",
    date: "2026-10-03",
  });
  const rules = prompt.indexOf("You are mini-coder");
  const tools = prompt.indexOf("### echo");
  const env = prompt.indexOf("## Environment");
  assert.ok(rules === 0 && rules < tools && tools < env, "sections in order");
  assert.match(prompt, /- project root: \/work\/app\n- platform: linux\n- date: 2026-10-03$/);
});
