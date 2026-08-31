import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolCalls, renderToolCatalog, renderToolResults } from "../src/protocol.js";
import { defaultTools } from "../src/tools.js";

test("catalog documents the format and every tool", () => {
  const catalog = renderToolCatalog(defaultTools);
  assert.match(catalog, /```tool_call/);
  assert.match(catalog, /### current_time/);
  assert.match(catalog, /input schema: \{/);
});

test("catalog is empty when there are no tools", () => {
  assert.equal(renderToolCatalog([]), "");
});

test("parses a call and strips it from the text", () => {
  const reply = 'Checking.\n\n```tool_call\n{"tool": "current_time", "input": {"timezone": "UTC"}}\n```';
  const { calls, text } = parseToolCalls(reply);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "current_time");
  assert.deepEqual(calls[0]?.args, { timezone: "UTC" });
  assert.equal(text, "Checking.");
});

test("parses several calls in one reply", () => {
  const reply =
    '```tool_call\n{"tool": "a", "input": {}}\n```\n```tool_call\n{"tool": "b", "input": {"x": 1}}\n```';
  const { calls } = parseToolCalls(reply);

  assert.deepEqual(
    calls.map((c) => c.name),
    ["a", "b"],
  );
  assert.deepEqual(
    calls.map((c) => c.id),
    ["call_1", "call_2"],
  );
});

test("input defaults to an empty object when omitted", () => {
  const { calls } = parseToolCalls('```tool_call\n{"tool": "a"}\n```');
  assert.deepEqual(calls[0]?.args, {});
});

test("malformed json becomes an unparseable call, not a throw", () => {
  const { calls } = parseToolCalls("```tool_call\n{not json}\n```");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "unparseable");
  assert.match(calls[0]?.raw ?? "", /not json/);
});

test("plain replies produce no calls", () => {
  const { calls, text } = parseToolCalls("Just an answer.");
  assert.equal(calls.length, 0);
  assert.equal(text, "Just an answer.");
});

test("a fenced block that is not a tool_call is left alone", () => {
  const reply = '```json\n{"tool": "current_time"}\n```';
  const { calls, text } = parseToolCalls(reply);
  assert.equal(calls.length, 0);
  assert.equal(text, reply);
});

test("results render with id, name, and error flag", () => {
  const rendered = renderToolResults([
    { id: "call_1", name: "a", output: "ok", isError: false },
    { id: "call_2", name: "b", output: "boom", isError: true },
  ]);

  assert.match(rendered, /\[call_1\] a result:\nok/);
  assert.match(rendered, /\[call_2\] b error:\nboom/);
});
