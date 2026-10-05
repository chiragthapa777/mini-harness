import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fold, initialState, type Action } from "../src/ui/fold.js";
import { editInput } from "../src/ui/input.js";
import { ACTIONS, firstSentence, menuFor } from "../src/ui/menu.js";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "../src/ui");

const run = (actions: Action[]) => actions.reduce(fold, initialState);

test("ui/ imports only the wire messages, never the rest of the core or the tools", async () => {
  const allowed = /^(node:|\.\/|ink$|react$|@mini-agent\/(coder-core\/wire|ink-markdown)$)/;

  for (const file of await readdir(uiDir)) {
    const source = await readFile(join(uiDir, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.match(specifier!, allowed, `${file} imports ${specifier}`);
    }
  }
});

test("a turn folds into user message, text, tool card, text", () => {
  const state = run([
    { type: "user", text: "run echo" },
    { type: "turn_start" },
    { type: "text_delta", text: "Check" },
    { type: "text_delta", text: "ing." },
    { type: "tool_start", callId: "call_1", name: "bash", input: { command: "echo hi" } },
    { type: "tool_output", callId: "call_1", chunk: "h" },
    { type: "tool_output", callId: "call_1", chunk: "i\n" },
    { type: "tool_end", callId: "call_1", output: "hi\n", isError: false },
    { type: "text_delta", text: "Done." },
    { type: "usage", inputTokens: 50, outputTokens: 5 },
    { type: "turn_end", stopReason: "end_turn" },
  ]);

  assert.deepEqual(state.items, [
    { kind: "user", text: "run echo" },
    { kind: "assistant", text: "Checking." },
    { kind: "tool", callId: "call_1", name: "bash", input: { command: "echo hi" }, output: "hi\n", status: "done" },
    { kind: "assistant", text: "Done." },
  ]);
  assert.equal(state.running, false);
  assert.deepEqual(state.usage, { inputTokens: 50, outputTokens: 5 });
});

test("thinking is its own item, joined up, and the reply after it starts a new one", () => {
  const thinking = run([
    { type: "turn_start" },
    { type: "thinking_delta", text: "The user wants" },
    { type: "thinking_delta", text: " a greeting." },
  ]);
  assert.deepEqual(thinking.items, [{ kind: "thinking", text: "The user wants a greeting." }]);
  assert.equal(thinking.thinking, true);

  const replied = fold(thinking, { type: "text_delta", text: "Hello!" });
  assert.deepEqual(replied.items.map((item) => item.kind), ["thinking", "assistant"]);
  assert.equal(replied.thinking, false);
});

test("a replay rebuilds the transcript and leaves nothing running", () => {
  const state = run([
    {
      type: "replay",
      messages: [
        { type: "user", text: "run echo" },
        { type: "text_delta", text: "Checking." },
        { type: "tool_start", callId: "call_1", name: "bash", input: { command: "echo hi" } },
        { type: "tool_end", callId: "call_1", output: "hi\n", isError: false },
        { type: "turn_end", stopReason: "end_turn" },
        { type: "user", text: "cut off mid-turn" }, // no turn_end: the session died here
      ],
    },
  ]);

  assert.deepEqual(state.items.map((item) => item.kind), ["user", "assistant", "tool", "user"]);
  assert.equal(state.running, false);
});

test("sending a message marks the turn running before the core says so", () => {
  assert.equal(run([{ type: "user", text: "hi" }]).running, true);
});

test("tool output streams into the running card, and a failed tool is marked", () => {
  const running = run([
    { type: "tool_start", callId: "call_1", name: "bash", input: {} },
    { type: "tool_output", callId: "call_1", chunk: "partial" },
  ]);
  assert.deepEqual(running.items.at(-1), {
    kind: "tool",
    callId: "call_1",
    name: "bash",
    input: {},
    output: "partial",
    status: "running",
  });

  const failed = fold(running, { type: "tool_end", callId: "call_1", output: "not run: denied", isError: true });
  const card = failed.items.at(-1);
  assert.deepEqual(card?.kind === "tool" && [card.output, card.status], ["not run: denied", "error"]);
});

test("a turn that stops early leaves a notice and stops running", () => {
  const aborted = run([{ type: "user", text: "hi" }, { type: "turn_end", stopReason: "aborted" }]);
  assert.deepEqual(aborted.items.at(-1), { kind: "notice", text: "interrupted", isError: false });
  assert.equal(aborted.running, false);

  const failed = run([{ type: "user", text: "hi" }, { type: "turn_end", stopReason: "error", error: "no key" }]);
  assert.deepEqual(failed.items.at(-1), { kind: "notice", text: "error: no key", isError: true });
});

test("the input line edits at the cursor, and a pasted line break is not Enter", () => {
  let line = editInput({ text: "", cursor: 0 }, "helo", {});
  line = editInput(line, "", { leftArrow: true });
  line = editInput(line, "l", {});
  assert.deepEqual(line, { text: "hello", cursor: 4 });

  line = editInput(line, "", { backspace: true });
  assert.deepEqual(line, { text: "helo", cursor: 3 });
  assert.deepEqual(editInput({ text: "ab", cursor: 0 }, "", { backspace: true }), { text: "ab", cursor: 0 });

  assert.equal(editInput({ text: "", cursor: 0 }, "one\ntwo\r", {}).text, "one two ");
  assert.deepEqual(editInput(line, "u", { ctrl: true }), { text: "", cursor: 0 });
});

test("the / menu lists actions and skills by prefix, and closes once arguments start", () => {
  const items = [...ACTIONS, { name: "release", description: "Cut a release" }, { name: "Compare", description: "Compare two files" }];
  const names = (text: string) => menuFor(text, items).map((item) => item.name);

  assert.deepEqual(names("/"), ["clear", "compact", "undo", "model", "tools", "help", "quit", "release", "Compare"]);
  assert.deepEqual(names("/co"), ["compact", "Compare"]);
  assert.deepEqual(names("/rel"), ["release"]);
  assert.deepEqual(names("/zzz"), []);
  assert.deepEqual(names("/model "), []); // typing the argument
  assert.deepEqual(names("hello /"), []);
  assert.deepEqual(names(""), []);

  assert.equal(firstSentence("Run a shell command.  `cd` carries over."), "Run a shell command.");
  assert.equal(firstSentence("x".repeat(100), 10), "xxxxxxxxx…");
});
