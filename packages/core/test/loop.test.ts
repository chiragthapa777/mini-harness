import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { z } from "zod";
import { runAgent } from "../src/loop.js";
import type { AgentTool, RunConfig, WorkingMemory } from "../src/types.js";

const wm: WorkingMemory = {
  systemPrompt: "You are a test agent.",
  procedural: ["always answer"],
  semantic: ["the user likes tests"],
  episodic: ["2026-01-01 user: hi"],
  history: [],
  userPrompt: "what time is it?",
};

const config: RunConfig = {
  provider: "anthropic",
  model: "claude-opus-5",
  maxTokens: 1024,
  guardrails: { maxIterations: 5, maxTokensPerRun: 100_000 },
};

const echo: AgentTool = {
  name: "echo",
  description: "echo the input back",
  schema: z.object({ value: z.string() }),
  async run(input) {
    return `echoed ${(input as { value: string }).value}`;
  },
};

const exploding: AgentTool = {
  name: "explode",
  description: "always throws",
  schema: z.object({}),
  async run() {
    throw new Error("tool blew up");
  },
};

/** A scripted chat model. Replaces the provider so the loop is testable offline. */
function fakeModel(replies: string[]) {
  const seen: Msg[][] = [];
  let index = 0;

  const model = {
    async invoke(messages: Msg[]) {
      seen.push([...messages]);
      return {
        text: replies[Math.min(index++, replies.length - 1)] ?? "",
        thinking: "",
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "stop",
      };
    },
  };

  return { model: model as unknown as ChatClient, seen, calls: () => index };
}

const callBlock = (tool: string, input: Record<string, unknown>) =>
  "```tool_call\n" + JSON.stringify({ tool, input }) + "\n```";

test("answers directly when no tool is called", async () => {
  const fake = fakeModel(["It is noon."]);
  const { reply, trace } = await runAgent(wm, [echo], config, { model: fake.model });

  assert.equal(reply, "It is noon.");
  assert.equal(trace.stopReason, "end_turn");
  assert.equal(trace.iterations, 1);
  assert.equal(trace.inputTokens, 10);
  assert.equal(trace.outputTokens, 5);
});

test("system prompt carries the catalog and retrieved memory", async () => {
  const fake = fakeModel(["done"]);
  await runAgent(wm, [echo], config, { model: fake.model });

  const system = String(fake.seen[0]?.[0]?.content ?? "");
  assert.match(system, /You are a test agent\./);
  assert.match(system, /### echo/);
  assert.match(system, /## How to act\n- always answer/);
  assert.match(system, /## What is known\n- the user likes tests/);
  assert.match(system, /## What happened before/);
});

test("runs a tool, feeds the result back, then answers", async () => {
  const fake = fakeModel([callBlock("echo", { value: "hi" }), "The tool said hi."]);
  const { reply, trace } = await runAgent(wm, [echo], config, { model: fake.model });

  assert.equal(reply, "The tool said hi.");
  assert.equal(trace.iterations, 2);
  assert.deepEqual(trace.steps[0]?.toolCalls, [
    { name: "echo", input: { value: "hi" }, isError: false },
  ]);

  const secondTurn = fake.seen[1] ?? [];
  assert.match(String(secondTurn.at(-1)?.content ?? ""), /\[call_1\] echo result:\nechoed hi/);
});

test("parallel calls all come back in one user turn", async () => {
  const fake = fakeModel([
    `${callBlock("echo", { value: "a" })}\n${callBlock("echo", { value: "b" })}`,
    "both done",
  ]);
  const { trace } = await runAgent(wm, [echo], config, { model: fake.model });

  assert.equal(trace.steps[0]?.toolCalls.length, 2);
  const results = String((fake.seen[1] ?? []).at(-1)?.content ?? "");
  assert.match(results, /echoed a/);
  assert.match(results, /echoed b/);
});

test("unknown tool is reported to the model, not thrown", async () => {
  const fake = fakeModel([callBlock("nope", {}), "understood"]);
  const { reply, trace } = await runAgent(wm, [echo], config, { model: fake.model });

  assert.equal(reply, "understood");
  assert.equal(trace.steps[0]?.toolCalls[0]?.isError, true);
  assert.match(String((fake.seen[1] ?? []).at(-1)?.content ?? ""), /unknown tool: nope/);
});

test("schema violations surface as tool errors", async () => {
  const fake = fakeModel([callBlock("echo", { value: 42 }), "ok"]);
  const { trace } = await runAgent(wm, [echo], config, { model: fake.model });

  assert.equal(trace.steps[0]?.toolCalls[0]?.isError, true);
});

test("a throwing tool does not kill the run", async () => {
  const fake = fakeModel([callBlock("explode", {}), "recovered"]);
  const { reply, trace } = await runAgent(wm, [exploding], config, { model: fake.model });

  assert.equal(reply, "recovered");
  assert.equal(trace.stopReason, "end_turn");
  assert.match(String((fake.seen[1] ?? []).at(-1)?.content ?? ""), /tool blew up/);
});

test("iteration guardrail stops a tool-calling loop", async () => {
  const fake = fakeModel([callBlock("echo", { value: "again" })]);
  const { trace } = await runAgent(
    wm,
    [echo],
    { ...config, guardrails: { maxIterations: 3, maxTokensPerRun: 100_000 } },
    { model: fake.model },
  );

  assert.equal(trace.stopReason, "max_iterations");
  assert.equal(trace.iterations, 3);
  assert.equal(fake.calls(), 3);
});

test("token budget stops the loop", async () => {
  const fake = fakeModel([callBlock("echo", { value: "again" })]);
  const { trace } = await runAgent(
    wm,
    [echo],
    { ...config, guardrails: { maxIterations: 50, maxTokensPerRun: 20 } },
    { model: fake.model },
  );

  assert.equal(trace.stopReason, "token_budget");
  assert.ok(trace.iterations < 50);
});

test("provider failure is captured in the trace, not thrown", async () => {
  const model = {
    async invoke() {
      throw new Error("provider down");
    },
  } as unknown as ChatClient;

  const { reply, trace } = await runAgent(wm, [echo], config, { model });

  assert.equal(reply, "");
  assert.equal(trace.stopReason, "error");
  assert.equal(trace.error, "provider down");
});

test("history is sent as-is between the system prompt and the user turn", async () => {
  const fake = fakeModel(["ok"]);
  const withHistory: WorkingMemory = {
    ...wm,
    history: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ],
  };

  await runAgent(withHistory, [echo], config, { model: fake.model });

  assert.deepEqual(fake.seen[0]?.slice(1), [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "what time is it?" },
  ]);
});

test("a truncated reply is traced as length, whatever the provider calls it", async () => {
  for (const reason of ["length", "max_tokens", "MAX_TOKENS"]) {
    const model = {
      async invoke() {
        return {
          text: "cut off mid-",
          thinking: "",
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: reason,
        };
      },
    } as unknown as ChatClient;

    const { trace } = await runAgent(wm, [echo], config, { model });
    assert.equal(trace.stopReason, "length", `${reason} should map to length`);
  }
});
