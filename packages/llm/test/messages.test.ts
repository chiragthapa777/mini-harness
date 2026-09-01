import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropicParams } from "../src/anthropic.js";
import { toGoogleParams } from "../src/google.js";
import { toOpenAIMessages, reasoningOf } from "../src/openai-compat.js";
import { collectStream, type Delta, type Msg } from "../src/types.js";

const conversation: Msg[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "again" },
];

// --- OpenAI wire format ----------------------------------------------------

test("openai keeps the system prompt inline and roles unchanged", () => {
  assert.deepEqual(toOpenAIMessages(conversation), [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
  ]);
});

test("reasoningOf reads both delta.reasoning and delta.reasoning_content", () => {
  const chunk = (delta: Record<string, unknown>) =>
    ({ choices: [{ delta }] }) as never;

  assert.equal(reasoningOf(chunk({ reasoning: "thinking" })), "thinking");
  assert.equal(reasoningOf(chunk({ reasoning_content: "also thinking" })), "also thinking");
  assert.equal(reasoningOf(chunk({ content: "text" })), "");
  assert.equal(reasoningOf({ choices: [] } as never), "");
});

// --- Anthropic -------------------------------------------------------------

test("anthropic lifts the system prompt out of the message list", () => {
  const { system, messages } = toAnthropicParams(conversation);
  assert.equal(system, "You are a test agent.");
  assert.deepEqual(messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
  ]);
});

test("anthropic merges adjacent same-role turns", () => {
  const { messages } = toAnthropicParams([
    { role: "user", content: "one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "ok" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "one\n\ntwo" },
    { role: "assistant", content: "ok" },
  ]);
});

test("anthropic drops a leading assistant turn", () => {
  const { messages } = toAnthropicParams([
    { role: "assistant", content: "orphaned reply" },
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("anthropic joins multiple system messages", () => {
  const { system } = toAnthropicParams([
    { role: "system", content: "a" },
    { role: "system", content: "b" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "a\n\nb");
});

// --- Google ----------------------------------------------------------------

test("google renames assistant to model and wraps text in parts", () => {
  const { systemInstruction, contents } = toGoogleParams(conversation);
  assert.equal(systemInstruction, "You are a test agent.");
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "hi" }] },
    { role: "user", parts: [{ text: "again" }] },
  ]);
});

test("google merges adjacent same-role turns into one content entry", () => {
  const { contents } = toGoogleParams([
    { role: "user", content: "one" },
    { role: "user", content: "two" },
  ]);
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "one" }, { text: "two" }] },
  ]);
});

// --- the stream fold -------------------------------------------------------

test("collectStream folds deltas into a completion", async () => {
  async function* deltas(): AsyncGenerator<Delta, void, undefined> {
    yield { type: "thinking", text: "let me " };
    yield { type: "thinking", text: "reason" };
    yield { type: "text", text: "Hello" };
    yield { type: "text", text: " there." };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } };
    yield { type: "finish", reason: "stop" };
  }

  assert.deepEqual(await collectStream(deltas()), {
    text: "Hello there.",
    thinking: "let me reason",
    usage: { inputTokens: 10, outputTokens: 4 },
    finishReason: "stop",
  });
});
