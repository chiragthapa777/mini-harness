import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "@mini-agent/coder-core";
import { connectMcp } from "../src/mcp.js";

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/mcp/test/fake-server.mjs");

test("MCP tools arrive as command tools named server__tool; a dead server is reported", async () => {
  const mcp = await connectMcp({
    fake: { command: process.execPath, args: [fakeServer] },
    broken: { command: "definitely-not-a-command-xyz" },
  });
  const controller = new AbortController();
  const ctx = { signal: controller.signal } as ToolContext;
  const tool = (name: string) => mcp.tools.find((t) => t.name === name)!;

  try {
    assert.deepEqual(mcp.tools.map((t) => `${t.name}:${t.kind}`), ["fake__echo:exec", "fake__explode:exec", "fake__hang:exec"]);
    assert.equal(mcp.problems.length, 1);
    assert.match(mcp.problems[0]!, /^MCP server "broken" is unavailable: /);

    const input = tool("fake__echo").schema.parse({ message: "hi", times: 2 });
    assert.equal(await tool("fake__echo").run(input, ctx), "hi hi");
    await assert.rejects(tool("fake__explode").run({}, ctx), /it blew up/);

    // Esc stops the wait, even though the server never answers.
    const hanging = tool("fake__hang").run({}, ctx);
    controller.abort(new Error("aborted by the user"));
    await assert.rejects(hanging, /aborted by the user/);
  } finally {
    mcp.close();
  }
});
