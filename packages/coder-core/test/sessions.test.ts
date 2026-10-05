import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { recallTool } from "../src/sessions.js";
import { SessionLog, Store } from "../src/store.js";
import type { ToolContext } from "../src/tool.js";
import { harness, shellTool, tempProject, toolCall } from "./helpers.js";

test("resume rebuilds the screen by replay and gives the model its history back", async () => {
  const logFile = join(await tempProject(), "sessions", "one.jsonl");
  const first = await harness({
    tools: [shellTool],
    replies: ["Running it.\n" + toolCall("shell", { command: "npm test" }), "Tests pass."],
    answers: ["allow"],
    logFile,
  });
  await first.turn("run the tests");

  const second = await harness({ replies: ["Nothing else."], logFile });
  assert.deepEqual(second.events[1], {
    type: "replay",
    messages: [
      { type: "user", text: "run the tests" },
      { type: "text_delta", text: "Running it.\n" },
      { type: "tool_start", callId: "call_1", name: "shell", input: { command: "npm test" } },
      { type: "tool_end", callId: "call_1", output: "ran npm test", isError: false },
      { type: "text_delta", text: "Tests pass." },
      { type: "turn_end", stopReason: "end_turn" },
    ],
  });

  await second.turn("anything else?");
  const seen = second.model.seen[0]!;
  assert.deepEqual(seen.map((m) => m.role), ["system", "user", "assistant", "user", "assistant", "user"]);
  assert.equal(seen[1]!.content, "run the tests");
  assert.match(seen[3]!.content, /shell result:\nran npm test/);
  assert.equal(seen[5]!.content, "anything else?");

  // Both sessions wrote to the one file, a line per turn.
  assert.equal(new SessionLog(logFile).read().length, 2);
});

test("resume after /clear: the screen keeps everything, the model starts over", async () => {
  const logFile = join(await tempProject(), "s.jsonl");
  const first = await harness({ replies: ["one", "two"], logFile });
  await first.turn("before");
  await first.command("clear");
  await first.turn("after");

  const second = await harness({ replies: ["three"], logFile });
  const replay = second.events[1];
  assert.deepEqual(replay?.type === "replay" && replay.messages.flatMap((m) => (m.type === "user" ? [m.text] : [])), [
    "before",
    "after",
  ]);
  await second.turn("next");
  assert.deepEqual(second.model.seen[0]!.map((m) => m.content).slice(1), ["after", "two", "next"]);
});

test("an interrupted turn is logged as it was shown, and a broken line is skipped", async () => {
  const logFile = join(await tempProject(), "s.jsonl");
  const first = await harness({ replies: [{ hang: "Let me think about" }], logFile });
  first.session.receive({ type: "submit", text: "question" });
  while (!first.events.some((e) => e.type === "text_delta")) await new Promise((resolve) => setImmediate(resolve));
  await first.session.stop();
  await writeFile(logFile, (await readFile(logFile, "utf8")) + '{"at": "cut sho');

  const [record, ...rest] = new SessionLog(logFile).read();
  assert.deepEqual(rest, []);
  assert.deepEqual(record!.messages.at(-1), { type: "turn_end", stopReason: "aborted" });
  assert.deepEqual(record!.history.map((m) => m.content), ["question", "Let me think about\n\n[interrupted by the user]"]);
});

test("a long session compacts before the next turn, and the summary survives a resume", async () => {
  const logFile = join(await tempProject(), "s.jsonl");
  // Each fake call reports 110 tokens of context.
  const h = await harness({ replies: ["first answer", "THE SUMMARY", "second answer"], limits: { compactAtTokens: 100 }, logFile });
  await h.turn("first question");
  await h.turn("second question");

  assert.ok(h.events.some((e) => e.type === "notice" && e.text === "conversation compacted"));
  // The summary call saw the whole history; the turn after it saw only the summary.
  assert.deepEqual(h.model.seen[1]!.map((m) => m.content).slice(1, 3), ["first question", "first answer"]);
  assert.match(h.model.seen[1]!.at(-1)!.content, /^Summarize this conversation/);
  assert.deepEqual(h.model.seen[2]!.map((m) => m.content).slice(1), [
    "Summary of the conversation so far:\n\nTHE SUMMARY",
    "Understood. I will continue from this summary.",
    "second question",
  ]);
  // The summary itself is never shown as a reply.
  assert.ok(!h.events.some((e) => e.type === "text_delta" && e.text.includes("SUMMARY")));

  const resumed = await harness({ replies: ["third answer"], logFile });
  await resumed.turn("third question");
  assert.deepEqual(resumed.model.seen[0]!.map((m) => m.content).slice(1), [
    "Summary of the conversation so far:\n\nTHE SUMMARY",
    "Understood. I will continue from this summary.",
    "second question",
    "second answer",
    "third question",
  ]);
});

test("/compact runs as a turn of its own, and has nothing to do on an empty conversation", async () => {
  const h = await harness({ replies: ["an answer", "SUMMARY", "later"] });
  h.session.receive({ type: "command", name: "compact" });
  await h.session.idle();
  assert.deepEqual(h.events.slice(1).map((e) => (e.type === "notice" ? e.text : e.type)), ["turn_start", "nothing to compact", "turn_end"]);
  assert.equal(h.model.calls(), 0);

  await h.turn("a question");
  h.session.receive({ type: "command", name: "compact" });
  h.session.receive({ type: "submit", text: "too early" }); // refused: compaction is a running turn
  assert.deepEqual(h.events.at(-1), { type: "notice", text: "a turn is already running", isError: true });
  await h.session.idle();

  await h.turn("next");
  assert.equal(h.model.seen[2]![1]!.content, "Summary of the conversation so far:\n\nSUMMARY");
});

test("recall finds earlier turns that contain every word, newest first", async () => {
  const folder = await tempProject();
  const older = await harness({ replies: ["Use drizzle-kit generate."], logFile: join(folder, "2026-01-01.jsonl") });
  await older.turn("how do I write a database migration?");
  const newer = await harness({ replies: ["Run pnpm db:migrate.", "It deploys from main."], logFile: join(folder, "2026-02-01.jsonl") });
  await newer.turn("how do I apply the migration?");
  await newer.turn("how does deploy work?");

  const logs = () => ["2026-01-01.jsonl", "2026-02-01.jsonl"].map((name) => new SessionLog(join(folder, name)));
  const recall = (query: string) => recallTool(logs).run({ query }, {} as ToolContext);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(
    await recall("Migration"),
    `[${today}] user: how do I apply the migration?\nassistant: Run pnpm db:migrate.\n\n` +
      `[${today}] user: how do I write a database migration?\nassistant: Use drizzle-kit generate.`,
  );
  assert.equal(await recall("deploys main"), `[${today}] user: how does deploy work?\nassistant: It deploys from main.`);
  assert.equal(await recall("kubernetes"), 'nothing in earlier sessions matches "kubernetes"');
});

test("the session file is new each run, or the latest one when resuming", async () => {
  const home = await tempProject();
  const store = new Store(home, "/work/my-app");
  assert.throws(() => store.openSession(true), /no earlier session/);

  const fresh = store.openSession(false).file;
  assert.equal(dirname(fresh), join(home, "projects", "-work-my-app", "sessions"));
  assert.match(basename(fresh), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}\.jsonl$/);

  const folder = dirname(fresh);
  const a = await harness({ replies: ["x"], logFile: join(folder, "2026-01-01T00-00-00-000Z-aaaaaaaa.jsonl") });
  await a.turn("old");
  const b = await harness({ replies: ["x"], logFile: join(folder, "2026-03-01T00-00-00-000Z-bbbbbbbb.jsonl") });
  await b.turn("new");
  assert.equal(basename(store.openSession(true).file), "2026-03-01T00-00-00-000Z-bbbbbbbb.jsonl");
  assert.deepEqual(store.sessionLogs().map((log) => basename(log.file)), [
    "2026-01-01T00-00-00-000Z-aaaaaaaa.jsonl",
    "2026-03-01T00-00-00-000Z-bbbbbbbb.jsonl",
  ]);
});
