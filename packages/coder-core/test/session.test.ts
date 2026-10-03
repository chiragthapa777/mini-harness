import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Tool } from "../src/tool.js";
import { echoTool, harness, shellTool, shownText, summary, tempProject, tick, toolCall } from "./helpers.js";

test("a full turn: tool call, permission, result, final reply", async () => {
  const h = await harness({
    tools: [shellTool],
    replies: ["Running it.\n" + toolCall("shell", { command: "npm test" }), "Tests pass."],
    answers: ["allow"],
  });

  const end = await h.turn("run the tests");

  assert.deepEqual(end, { type: "turn_end", stopReason: "end_turn" });
  assert.deepEqual(summary(h.events), ["start shell", "end ok: ran npm test", "turn_end end_turn"]);
  assert.ok(h.events.some((e) => e.type === "tool_output" && e.chunk === "line 1\n"));
  assert.equal(shownText(h.events), "Running it.\nTests pass."); // the tool_call block is hidden
  assert.deepEqual(h.asked, [{ callId: "call_1", tool: "shell", input: { command: "npm test" }, reason: "commands ask first" }]);

  // The second model call got the tool result back.
  const second = h.model.seen[1]!;
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.match(second[3]!.content, /\[call_1\] shell result:\nran npm test/);
});

test("reads never ask", async () => {
  const h = await harness({ replies: [toolCall("echo", { text: "hi" }), "done"] });
  await h.turn("echo");
  assert.deepEqual(h.asked, []);
  assert.deepEqual(summary(h.events), ["start echo", "end ok: echo: hi", "turn_end end_turn"]);
});

test("a denied call is reported to the model", async () => {
  const h = await harness({ tools: [shellTool], replies: [toolCall("shell", { command: "rm -rf /" }), "ok"], answers: ["deny"] });
  await h.turn("clean up");
  assert.ok(summary(h.events).includes("end error: not run: the user denied this call"));
});

test("'always' covers a command only verbatim", async () => {
  const h = await harness({
    tools: [shellTool],
    replies: [
      toolCall("shell", { command: "npm test" }),
      toolCall("shell", { command: "npm test" }),
      toolCall("shell", { command: "rm -rf build" }),
      "done",
    ],
    answers: ["always", "deny"],
  });
  await h.turn("go");
  assert.deepEqual(h.asked.map((a) => (a.input as { command: string }).command), ["npm test", "rm -rf build"]);
});

test("plan mode refuses writes without asking", async () => {
  const write: Tool = { ...echoTool, name: "write", kind: "write", run: async () => assert.fail("must not run") };
  const h = await harness({ tools: [write], replies: [toolCall("write", { text: "x" }), "ok"], mode: "plan" });
  await h.turn("write");
  assert.deepEqual(h.asked, []);
  assert.ok(summary(h.events).includes("end error: not run: plan mode is read-only"));
});

test("bad tool calls become error results and the turn goes on", async () => {
  const h = await harness({
    replies: [[toolCall("nope", {}), toolCall("echo", { text: 42 }), "```tool_call\n{not json}\n```"].join("\n"), "sorry"],
  });
  const end = await h.turn("try");
  assert.equal(end.type === "turn_end" && end.stopReason, "end_turn");
  const errors = summary(h.events).filter((line) => line.startsWith("end error"));
  assert.match(errors[0]!, /unknown tool "nope"/);
  assert.match(errors[1]!, /invalid input for echo/);
  assert.match(errors[2]!, /could not parse the tool_call block/);
});

test("Esc while streaming: the turn ends 'aborted' and keeps what was shown", async () => {
  const h = await harness({ replies: [{ hang: "Let me think about" }, "answer"] });
  const ended = h.turn("question");
  while (!h.events.some((e) => e.type === "text_delta")) await tick();
  await h.ui.abort();
  await ended;

  assert.deepEqual(summary(h.events), ["turn_end aborted"]);
  assert.equal(shownText(h.events), "Let me think about");

  // The next turn works, and the model sees where it was cut off.
  await h.turn("again");
  assert.equal(h.model.seen[1]![2]!.content, "Let me think about\n\n[interrupted by the user]");
});

test("Esc during a permission prompt: nothing runs", async () => {
  let ran = false;
  const shell: Tool = { ...shellTool, run: async () => ((ran = true), "ran") };
  const h = await harness({ tools: [shell], replies: [toolCall("shell", { command: "deploy" })], answers: ["never"] });

  const ended = h.turn("ship it");
  while (h.asked.length === 0) await tick();
  await h.ui.abort();
  await ended;

  assert.equal(ran, false);
  assert.deepEqual(summary(h.events), ["start shell", "end error: not run: the user aborted the turn", "turn_end aborted"]);
});

test("one turn at a time", async () => {
  const h = await harness({ replies: [{ hang: "working" }] });
  await h.ui.submit("first");
  await assert.rejects(h.ui.submit("second"), /a turn is already running/);
  await assert.rejects(h.ui.command("clear"), /cannot run during a turn/);
  await h.ui.abort();
  await h.session.idle();
});

test("the iteration cap and the token budget stop a runaway turn", async () => {
  const loop = await harness({ replies: [toolCall("echo", { text: "again" })], limits: { maxIterations: 3 } });
  assert.deepEqual(await loop.turn("go"), { type: "turn_end", stopReason: "max_iterations" });
  assert.equal(loop.model.calls(), 3);

  // Each fake call uses 110 tokens.
  const spend = await harness({ replies: [toolCall("echo", { text: "again" })], limits: { maxTokensPerTurn: 250 } });
  assert.deepEqual(await spend.turn("go"), { type: "turn_end", stopReason: "token_budget" });
});

test("a model error ends the turn with its message", async () => {
  const h = await harness({ replies: [{ fail: "429 rate limited" }] });
  assert.deepEqual(await h.turn("hi"), { type: "turn_end", stopReason: "error", error: "429 rate limited" });
});

test("/undo restores the files changed in the last turn", async () => {
  const cwd = await tempProject();
  await writeFile(join(cwd, "a.txt"), "original");
  const schema = z.object({ path: z.string(), content: z.string() });
  const write: Tool<typeof schema> = {
    name: "write",
    description: "writes a file",
    kind: "write",
    schema,
    async run({ path, content }, ctx) {
      await ctx.checkpoint(join(ctx.root, path));
      await writeFile(join(ctx.root, path), content);
      return "ok";
    },
  };

  const h = await harness({
    tools: [write],
    cwd,
    mode: "accept-edits",
    replies: [toolCall("write", { path: "a.txt", content: "changed" }) + toolCall("write", { path: "new.txt", content: "x" }), "done"],
  });
  await h.turn("edit");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "changed");

  assert.deepEqual(await h.ui.command("undo"), { message: "restored a.txt, new.txt. Changes made through bash are not undone." });
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
  assert.deepEqual(await h.ui.command("undo"), { message: "nothing to undo" });
});

test("/clear and /model", async () => {
  const h = await harness({ replies: ["one", "two"] });
  await h.turn("first");
  await h.ui.command("clear");
  await h.turn("second");
  assert.deepEqual(h.model.seen[1]!.map((m) => m.role), ["system", "user"]);

  assert.deepEqual(await h.ui.command("model"), { message: "model: openrouter:z-ai/glm-5.3-flash" });
  assert.deepEqual(await h.ui.command("model", "anthropic:claude-opus-5"), { message: "model set to anthropic:claude-opus-5" });
  await assert.rejects(h.ui.command("model", "nonsense"), /provider:model/);
});

test("initialize checks the folder and the model", async () => {
  await assert.rejects(harness({ replies: [], cwd: "/not/a/folder" }), /not a directory/);
  await assert.rejects(harness({ replies: [], model: "acme:gpt" }), /unknown provider "acme"/);

  const h = await harness({ replies: [], model: "google:gemini-2.5-pro", mode: "accept-edits" });
  assert.equal(h.init.model, "google:gemini-2.5-pro");
  assert.equal(h.init.mode, "accept-edits");
  await assert.rejects(h.ui.initialize({ cwd: h.cwd }), /already initialized/);
});

test("shutdown aborts the turn and exits exactly once", async () => {
  const h = await harness({ replies: [{ hang: "long task" }] });
  const ended = h.turn("go");
  await h.ui.shutdown();
  await ended;
  await tick();
  assert.equal(h.shutdowns(), 1);
  assert.deepEqual(summary(h.events), ["turn_end aborted"]);

  h.wires.close(); // the UI then closes the pipe
  await tick();
  assert.equal(h.shutdowns(), 1);
});

test("the UI going away counts as shutdown", async () => {
  const h = await harness({ replies: [{ hang: "long task" }] });
  await h.ui.submit("go");
  h.wires.close();
  while (h.shutdowns() === 0) await tick(); // the close event arrives asynchronously
  assert.deepEqual(summary(h.events), []); // the UI was gone before turn_end
  assert.equal(h.shutdowns(), 1);
});
