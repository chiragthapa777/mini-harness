import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ToolCallTextFilter,
  parseToolCalls,
  renderToolCatalog,
  renderToolResults,
  TOOL_CALL_FENCE,
} from "@mini-agent/core/protocol";

test("the protocol subpath export exposes the whole wire format", () => {
  assert.equal(TOOL_CALL_FENCE, "tool_call");
  assert.equal(typeof renderToolCatalog, "function");
  assert.equal(typeof renderToolResults, "function");
  assert.equal(typeof ToolCallTextFilter, "function");

  const { calls } = parseToolCalls('```tool_call\n{"tool": "read_file", "input": {"path": "a.ts"}}\n```');
  assert.deepEqual(
    calls.map(({ name, args }) => ({ name, args })),
    [{ name: "read_file", args: { path: "a.ts" } }],
  );
});

test("protocol.ts has no runtime import beyond zod", async () => {
  // Importing the subpath must not drag in the server's tools or the search
  // stack; type-only imports are erased and do not count.
  const source = await readFile(new URL("../src/protocol.ts", import.meta.url), "utf8");
  const runtime = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(runtime, ["zod"]);
});
