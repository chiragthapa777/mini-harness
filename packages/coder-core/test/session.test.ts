import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ErrorCode } from "@mini-agent/coder-protocol";
import { echoTool, harness, shape, shellTool, tempProject, text, toolCall, writeTool } from "./helpers.js";

test("a full turn: tool call → permission → result → final reply", async () => {
  const h = await harness({
    tools: [echoTool, shellTool],
    replies: ["Running it.\n" + toolCall("shell", { command: "npm test" }), "All tests pass."],
    answers: ["allow"],
  });

  const end = await h.turn("run the tests");

  assert.equal(end.stopReason, "end_turn");
  assert.deepEqual(shape(h.events), [
    "turn_start",
    "tool_start shell",
    'tool_output "line 1\\n"',
    'tool_output "line 2\\n"',
    "tool_end ok: ran npm test",
    "turn_end end_turn",
  ]);
  // The fence never reaches the screen; the prose around it does.
  assert.equal(text(h.events), "Running it.\nAll tests pass.");

  assert.deepEqual(h.asked, [
    { callId: "call_1", tool: "shell", input: { command: "npm test" }, reason: "commands ask by default" },
  ]);

  // Second model call saw the system prompt, the user turn, its own call, and the result.
  const second = h.model.seen[1]!;
  assert.equal(second[0]!.role, "system");
  assert.match(second[0]!.content, /### shell/);
  assert.deepEqual(
    second.slice(1).map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.match(second[3]!.content, /\[call_1\] shell result:\nran npm test/);
});

test("reads run without asking", async () => {
  const h = await harness({
    replies: [toolCall("echo", { text: "hi" }), "done"],
  });
  await h.turn("echo something");
  assert.deepEqual(h.asked, []);
  assert.ok(shape(h.events).includes("tool_end ok: echo: hi"));
});

test("a denied call is reported to the model, which carries on", async () => {
  const h = await harness({
    tools: [shellTool],
    replies: [toolCall("shell", { command: "rm -rf /" }), "Understood, I won't."],
    answers: ["deny"],
  });

  const end = await h.turn("clean up");
  assert.equal(end.stopReason, "end_turn");
  assert.ok(shape(h.events).includes("tool_end error: not run: the user denied this call"));
  assert.match(h.model.seen[1]!.at(-1)!.content, /shell error:\nnot run: the user denied this call/);
});

test("always: an exec call is trusted verbatim, not as a whole tool", async () => {
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
  // Asked for the first npm test and for rm, never for the repeat.
  assert.deepEqual(
    h.asked.map((a) => (a.input as { command: string }).command),
    ["npm test", "rm -rf build"],
  );
});

test("plan mode refuses writes without asking", async () => {
  const project = await tempProject();
  const h = await harness({
    tools: [writeTool(async () => assert.fail("must not run"))],
    replies: [toolCall("write", { path: "a.txt", content: "x" }), "ok"],
    init: { cwd: project, mode: "plan" },
  });

  await h.turn("write a file");
  assert.deepEqual(h.asked, []);
  assert.ok(shape(h.events).includes("tool_end error: not run: plan mode is read-only"));
});

test("unknown tools, bad input and broken blocks become error results", async () => {
  const h = await harness({
    replies: [
      [
        toolCall("nope", {}),
        toolCall("echo", { text: 42 }),
        "```tool_call\n{not json}\n```",
      ].join("\n"),
      "sorry",
    ],
  });

  const end = await h.turn("try things");
  assert.equal(end.stopReason, "end_turn");
  const errors = shape(h.events).filter((line) => line.startsWith("tool_end error"));
  assert.equal(errors.length, 3);
  assert.match(errors[0]!, /unknown tool "nope". Available: echo/);
  assert.match(errors[1]!, /invalid input for echo: text:/);
  assert.match(errors[2]!, /could not parse the tool_call block/);
});

test("Esc mid-stream: the turn ends aborted and keeps what was shown", async () => {
  const h = await harness({ replies: [{ hang: "Let me think about" }, "fresh answer"] });

  const streaming = h.next((e) => e.type === "text_delta");
  const ended = h.next((e) => e.type === "turn_end");
  await h.ui.request("submit", { text: "question" });
  await streaming;
  await h.ui.request("abort", {});
  await ended;

  assert.deepEqual(shape(h.events), ["turn_start", "turn_end aborted"]);
  assert.equal(text(h.events), "Let me think about");

  // The session is usable again, and the model sees where it was cut off.
  const second = await h.turn("try again");
  assert.equal(second.stopReason, "end_turn");
  const history = h.model.seen[1]!;
  assert.equal(history[2]!.role, "assistant");
  assert.match(history[2]!.content, /Let me think about\n\n\[interrupted by the user\]$/);
});

test("Esc while a permission prompt is open: nothing runs", async () => {
  let ran = false;
  const h = await harness({
    tools: [{ ...shellTool, run: async () => ((ran = true), "ran") }],
    replies: [toolCall("shell", { command: "deploy" }), "unreachable"],
    answers: ["never"],
  });

  const asking = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (h.asked.length) {
        clearInterval(check);
        resolve();
      }
    }, 1);
  });
  const ended = h.next((e) => e.type === "turn_end");
  await h.ui.request("submit", { text: "ship it" });
  await asking;
  await h.ui.request("abort", {});
  await ended;

  assert.equal(ran, false);
  assert.deepEqual(shape(h.events), [
    "turn_start",
    "tool_start shell",
    "tool_end error: not run: the user aborted the turn",
    "turn_end aborted",
  ]);
  assert.equal(h.model.calls(), 1);
});

test("one turn at a time", async () => {
  const h = await harness({ replies: [{ hang: "working" }] });
  await h.ui.request("submit", { text: "first" });
  await assert.rejects(h.ui.request("submit", { text: "second" }), {
    code: ErrorCode.Rejected,
    message: "a turn is already running",
  });
  await assert.rejects(h.ui.request("command", { name: "clear" }), { code: ErrorCode.Rejected });
  await h.ui.request("abort", {});
  await h.session.idle();
});

test("the iteration cap stops a model that never finishes", async () => {
  const h = await harness({
    replies: [toolCall("echo", { text: "again" })],
    deps: { limits: { maxIterations: 3 } },
  });
  const end = await h.turn("loop forever");
  assert.equal(end.stopReason, "max_iterations");
  assert.equal(h.model.calls(), 3);
});

test("the token budget stops a turn", async () => {
  // Each fake call reports 110 tokens.
  const h = await harness({
    replies: [toolCall("echo", { text: "again" })],
    deps: { limits: { maxTokensPerTurn: 250 } },
  });
  const end = await h.turn("spend");
  assert.equal(end.stopReason, "token_budget");
  assert.equal(h.model.calls(), 3);
});

test("a provider error ends the turn with the message", async () => {
  const h = await harness({ replies: [{ fail: "429 rate limited" }] });
  const end = await h.turn("hello");
  assert.deepEqual(end, { type: "turn_end", stopReason: "error", error: "429 rate limited" });
});

test("/undo restores the last turn's files and tells the model", async () => {
  const project = await tempProject();
  const file = join(project, "notes.txt");
  await writeFile(file, "original\n");

  const tool = writeTool(async ({ path, content }, ctx) => {
    const target = join(ctx.root, path);
    await ctx.checkpoint(target);
    await writeFile(target, content);
  });

  const h = await harness({
    tools: [tool],
    replies: [
      [toolCall("write", { path: "notes.txt", content: "first\n" }), toolCall("write", { path: "new.txt", content: "x" })].join("\n"),
      "done",
      "noted",
    ],
    answers: ["always"],
    init: { cwd: project },
  });

  await h.turn("edit");
  assert.equal(await readFile(file, "utf8"), "first\n");

  const { message } = await h.ui.request("command", { name: "undo" });
  assert.match(message, /^restored 2 files: notes.txt, new.txt\. Changes made through bash are not undone\.$/);
  assert.equal(await readFile(file, "utf8"), "original\n");
  await assert.rejects(readFile(join(project, "new.txt")), { code: "ENOENT" });

  assert.equal((await h.ui.request("command", { name: "undo" })).message, "nothing to undo");

  await h.turn("what now?");
  assert.match(h.model.seen.at(-1)!.at(-1)!.content, /^\[note: the user undid your last file changes: notes.txt, new.txt/);
});

test("/clear empties the conversation; /model reports and switches", async () => {
  const h = await harness({ replies: ["one", "two"] });
  await h.turn("first");
  assert.equal((await h.ui.request("command", { name: "clear" })).message, "conversation cleared");
  await h.turn("second");
  assert.deepEqual(
    h.model.seen[1]!.map((m) => m.role),
    ["system", "user"],
  );

  assert.equal((await h.ui.request("command", { name: "model" })).message, "model: openrouter:z-ai/glm-5.3-flash");
  assert.equal(
    (await h.ui.request("command", { name: "model", arg: "anthropic:claude-opus-5" })).message,
    "model set to anthropic:claude-opus-5",
  );
  await assert.rejects(h.ui.request("command", { name: "model", arg: "nonsense" }), {
    code: ErrorCode.InvalidParams,
  });
});

test("initialize validates the project root and the model", async () => {
  await assert.rejects(harness({ replies: [], init: { cwd: "/definitely/not/here" } }), {
    code: ErrorCode.Rejected,
  });
  await assert.rejects(harness({ replies: [], init: { model: "acme:gpt" } }), {
    code: ErrorCode.InvalidParams,
    message: /unknown provider "acme"/,
  });

  const h = await harness({ replies: [], init: { model: "google:gemini-2.5-pro", mode: "accept-edits" } });
  assert.equal(h.init.model, "google:gemini-2.5-pro");
  assert.equal(h.init.mode, "accept-edits");
  await assert.rejects(h.ui.initialize({ cwd: h.root }), { message: "already initialized" });
});

test("shutdown aborts the running turn, answers, then exits once", async () => {
  const h = await harness({ replies: [{ hang: "long task" }] });
  const ended = h.next((e) => e.type === "turn_end");
  await h.ui.request("submit", { text: "go" });

  await h.ui.request("shutdown", {});
  await ended;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shutdowns(), 1);
  assert.deepEqual(shape(h.events), ["turn_start", "turn_end aborted"]);

  // The UI then closes the pipe: still exactly one exit.
  h.wires.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shutdowns(), 1);
});

test("the UI disappearing counts as shutdown", async () => {
  const h = await harness({ replies: [{ hang: "long task" }] });
  await h.ui.request("submit", { text: "go" });
  h.wires.close();
  await h.session.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shutdowns(), 1);
});
