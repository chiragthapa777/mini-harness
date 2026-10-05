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
  assert.deepEqual(h.asked, [{ callId: "call_1", tool: "shell", input: { command: "npm test" } }]);

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
  const h = await harness({ tools: [shellTool], replies: [toolCall("shell", { command: "rm -rf build" }), "ok"], answers: ["deny"] });
  await h.turn("clean up");
  assert.ok(summary(h.events).includes("end error: not run: the user denied this call"));
});

test("'always' covers a command only verbatim, and is saved to the chosen settings", async () => {
  const h = await harness({
    tools: [shellTool],
    replies: [
      toolCall("shell", { command: "npm test" }),
      toolCall("shell", { command: "npm test" }),
      toolCall("shell", { command: "rm -rf build" }),
      "done",
    ],
    answers: ["always_project", "deny"],
  });
  await h.turn("go");
  assert.deepEqual(h.asked.map((a) => (a.input as { command: string }).command), ["npm test", "rm -rf build"]);
  assert.deepEqual(h.saved, { project: { permissions: { allow: ["shell(npm test)"] } }, user: {} });
});

test("'always' for every project saves to the user's settings", async () => {
  const write: Tool = { ...echoTool, name: "write", kind: "write" };
  const h = await harness({ tools: [write], replies: [toolCall("write", { text: "x" }), "ok"], answers: ["always_user"] });
  await h.turn("write");
  assert.deepEqual(h.saved, { project: {}, user: { permissions: { allow: ["write"] } } });
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
  h.session.receive({ type: "abort" });
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
  h.session.receive({ type: "abort" });
  await ended;

  assert.equal(ran, false);
  assert.deepEqual(summary(h.events), ["start shell", "end error: not run: the user aborted the turn", "turn_end aborted"]);
});

test("one turn at a time", async () => {
  const h = await harness({ replies: [{ hang: "working" }] });
  h.session.receive({ type: "submit", text: "first" });
  h.session.receive({ type: "submit", text: "second" });
  assert.deepEqual(h.events.at(-1), { type: "notice", text: "a turn is already running", isError: true });
  assert.deepEqual(await h.command("clear"), { type: "notice", text: "/clear cannot run during a turn", isError: true });
  await h.session.stop();
  assert.deepEqual(summary(h.events), ["turn_end aborted"]);
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

  assert.equal((await h.command("undo")).text, "restored a.txt, new.txt. Changes made through bash are not undone.");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
  assert.equal((await h.command("undo")).text, "nothing to undo");
});

test("/clear and /model", async () => {
  const h = await harness({ replies: ["one", "two"] });
  await h.turn("first");
  await h.command("clear");
  await h.turn("second");
  assert.deepEqual(h.model.seen[1]!.map((m) => m.role), ["system", "user"]);

  assert.equal((await h.command("model")).text, "model: openrouter:z-ai/glm-5.3-flash");
  assert.equal((await h.command("model", "anthropic:claude-opus-5")).text, "model set to anthropic:claude-opus-5 for this project");
  assert.deepEqual(h.saved.project, { model: "anthropic:claude-opus-5" });
  const session = h.events.at(-2);
  assert.equal(session?.type === "session" && session.model, "anthropic:claude-opus-5");
  const refused = await h.command("model", "nonsense");
  assert.match(refused.text, /provider:model/);
  assert.equal(refused.isError, true);
});

test("a session checks the folder and the model, then says what it runs with", async () => {
  await assert.rejects(harness({ replies: [], cwd: "/not/a/folder" }), /not a directory/);
  await assert.rejects(harness({ replies: [], model: "acme:gpt" }), /unknown provider "acme"/);

  const h = await harness({ replies: [], model: "google:gemini-2.5-pro", mode: "accept-edits" });
  assert.deepEqual(h.events, [
    {
      type: "session",
      model: "google:gemini-2.5-pro",
      mode: "accept-edits",
      tools: [{ name: "echo", description: "returns its input" }],
      skills: [],
    },
  ]);
});

test("/name runs a skill: the model is told to load it, the screen and the log keep what was typed", async () => {
  const logFile = join(await tempProject(), "s.jsonl");
  const skills = [{ name: "release", description: "Cut a release" }];
  const h = await harness({ replies: ["ok", "ok", "ok"], skills, logFile });
  assert.deepEqual(h.events[0]?.type === "session" && h.events[0].skills, skills);

  await h.turn("/release 1.2 today");
  assert.equal(h.model.seen[0]!.at(-1)!.content, 'Use the "release" skill: load it with the skill tool, then follow it.\n\n1.2 today');
  assert.match(await readFile(logFile, "utf8"), /"type":"user","text":"\/release 1.2 today"/);

  // Anything that is not a skill's name goes to the model as typed.
  await h.turn("/releases are slow");
  assert.equal(h.model.seen[1]!.at(-1)!.content, "/releases are slow");
});
