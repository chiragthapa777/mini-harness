import assert from "node:assert/strict";
import { test } from "node:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { z } from "zod";
import { runAgentStream } from "../src/stream.js";
import { ToolCallTextFilter } from "../src/protocol.js";
import type { AgentTool, RunConfig, RunEvent, WorkingMemory } from "../src/types.js";

const wm: WorkingMemory = {
  systemPrompt: "You are a test agent.",
  procedural: [],
  semantic: [],
  episodic: [],
  history: [],
  userPrompt: "hello",
};

const config: RunConfig = {
  provider: "openrouter",
  model: "z-ai/glm-5.3-flash",
  maxTokens: 1024,
  guardrails: { maxIterations: 5, maxTokensPerRun: 100_000 },
};

const echo: AgentTool = {
  name: "echo",
  description: "echo input",
  schema: z.object({ value: z.string() }),
  async run(input) {
    return `echoed ${(input as { value: string }).value}`;
  },
};

/** Splits scripted replies into single characters, worst case for the filter. */
function streamingModel(turns: string[], reasoning: string[] = []) {
  let turn = 0;

  const model = {
    async stream(_messages: unknown) {
      const text = turns[Math.min(turn, turns.length - 1)] ?? "";
      const think = reasoning[turn] ?? "";
      turn += 1;

      return (async function* () {
        if (think) {
          yield new AIMessageChunk({ content: "", additional_kwargs: { reasoning: think } });
        }
        for (const char of text) yield new AIMessageChunk({ content: char });
        yield new AIMessageChunk({
          content: "",
          usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          response_metadata: { finish_reason: "stop" },
        });
      })();
    },
  };

  return model as unknown as BaseChatModel;
}

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const deltas = (events: RunEvent[]) =>
  events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");

const callBlock = (tool: string, input: Record<string, unknown>) =>
  "```tool_call\n" + JSON.stringify({ tool, input }) + "\n```";

test("streams a plain answer and ends with reply then trace", async () => {
  const events = await collect(
    runAgentStream(wm, [echo], config, { model: streamingModel(["Hello there."]) }),
  );

  assert.equal(events[0]?.type, "run_start");
  assert.equal(deltas(events), "Hello there.");
  assert.equal(events.at(-2)?.type, "reply");
  assert.equal(events.at(-1)?.type, "trace");

  const trace = events.at(-1);
  assert.ok(trace?.type === "trace");
  assert.equal(trace.trace.stopReason, "end_turn");
  assert.equal(trace.trace.inputTokens, 10);
});

test("tool_call blocks never reach the visible stream", async () => {
  const model = streamingModel([
    `Let me check.\n${callBlock("echo", { value: "hi" })}`,
    "All done.",
  ]);
  const events = await collect(runAgentStream(wm, [echo], config, { model }));

  const visible = deltas(events);
  assert.doesNotMatch(visible, /tool_call/);
  assert.doesNotMatch(visible, /```/);
  assert.match(visible, /Let me check\./);
  assert.match(visible, /All done\./);
});

test("emits tool_call then tool_result with the output", async () => {
  const model = streamingModel([callBlock("echo", { value: "hi" }), "done"]);
  const events = await collect(runAgentStream(wm, [echo], config, { model }));

  const call = events.find((e) => e.type === "tool_call");
  const result = events.find((e) => e.type === "tool_result");

  assert.ok(call?.type === "tool_call" && result?.type === "tool_result");
  assert.equal(call.name, "echo");
  assert.deepEqual(call.input, { value: "hi" });
  assert.equal(result.output, "echoed hi");
  assert.equal(result.isError, false);
  assert.ok(events.indexOf(call) < events.indexOf(result));
});

test("failing tools stream as tool_result with isError", async () => {
  const model = streamingModel([callBlock("missing", {}), "recovered"]);
  const events = await collect(runAgentStream(wm, [echo], config, { model }));

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result?.type === "tool_result");
  assert.equal(result.isError, true);
  assert.match(result.output, /unknown tool: missing/);
});

test("reasoning tokens stream as thinking_delta", async () => {
  const model = streamingModel(["answer"], ["let me reason about this"]);
  const events = await collect(runAgentStream(wm, [echo], config, { model }));

  const thinking = events
    .filter((e) => e.type === "thinking_delta")
    .map((e) => e.text)
    .join("");
  assert.equal(thinking, "let me reason about this");
});

test("iteration events bracket every model call", async () => {
  const model = streamingModel([callBlock("echo", { value: "x" }), "done"]);
  const events = await collect(runAgentStream(wm, [echo], config, { model }));

  const starts = events.filter((e) => e.type === "iteration_start");
  const ends = events.filter((e) => e.type === "iteration_end");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
});

test("guardrail event fires when iterations run out", async () => {
  const model = streamingModel([callBlock("echo", { value: "again" })]);
  const events = await collect(
    runAgentStream(
      wm,
      [echo],
      { ...config, guardrails: { maxIterations: 2, maxTokensPerRun: 100_000 } },
      { model },
    ),
  );

  const guardrail = events.find((e) => e.type === "guardrail");
  assert.ok(guardrail?.type === "guardrail");
  assert.equal(guardrail.reason, "max_iterations");
});

test("provider failures stream as an error event and still emit a trace", async () => {
  const model = {
    async stream() {
      throw new Error("stream exploded");
    },
  } as unknown as BaseChatModel;

  const events = await collect(runAgentStream(wm, [echo], config, { model }));
  const error = events.find((e) => e.type === "error");

  assert.ok(error?.type === "error");
  assert.equal(error.message, "stream exploded");
  assert.equal(events.at(-1)?.type, "trace");
});

// --- the filter itself, character by character -----------------------------

function filtered(text: string, chunkSize = 1): string {
  const filter = new ToolCallTextFilter();
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    out += filter.push(text.slice(i, i + chunkSize));
  }
  return out + filter.flush();
}

test("filter passes plain text through untouched", () => {
  assert.equal(filtered("just some prose"), "just some prose");
});

test("filter strips a tool_call block arriving one char at a time", () => {
  const text = `before\n${callBlock("echo", { value: "x" })}\nafter`;
  assert.equal(filtered(text).replace(/\n+/g, "\n"), "before\n\nafter".replace(/\n+/g, "\n"));
});

test("filter keeps ordinary code fences", () => {
  const text = "run this:\n```js\nconsole.log(1)\n```\ndone";
  assert.equal(filtered(text), text);
});

test("filter drops an unterminated tool_call block", () => {
  assert.equal(filtered('text\n```tool_call\n{"tool":"a"'), "text\n");
});

test("filter is chunk-size independent", () => {
  const text = `a\n${callBlock("echo", { value: "y" })}\nb`;
  assert.equal(filtered(text, 1), filtered(text, 7));
  assert.equal(filtered(text, 1), filtered(text, 1000));
});
