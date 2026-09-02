import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { McpClient } from "../src/client.js";
import { jsonSchemaToZod } from "../src/schema.js";
import { closeMcpClients, mcpTools } from "../src/tools.js";

const SERVER = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
const config = { command: process.execPath, args: [SERVER], timeoutMs: 2_000 };

describe("mcp client", () => {
  after(() => closeMcpClients());

  it("handshakes and lists the server's tools", async () => {
    const client = new McpClient("fake", config);
    try {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["echo", "explode", "hang"],
      );
      assert.equal(tools[0]?.description, "Echo a message back");
    } finally {
      client.close();
    }
  });

  it("calls a tool and flattens its content blocks to text", async () => {
    const client = new McpClient("fake", config);
    try {
      assert.equal(await client.callTool("echo", { message: "hi", times: 3 }), "hi hi hi");
    } finally {
      client.close();
    }
  });

  it("turns an isError result into a thrown error", async () => {
    const client = new McpClient("fake", config);
    try {
      await assert.rejects(() => client.callTool("explode", {}), /it blew up/);
    } finally {
      client.close();
    }
  });

  it("reports a JSON-RPC error rather than hanging", async () => {
    const client = new McpClient("fake", config);
    try {
      await assert.rejects(() => client.callTool("nope", {}), /unknown tool: nope/);
    } finally {
      client.close();
    }
  });

  it("times out a tool that never answers", async () => {
    const client = new McpClient("fake", { ...config, timeoutMs: 300 });
    try {
      await assert.rejects(() => client.callTool("hang", {}), /timed out/);
    } finally {
      client.close();
    }
  });

  it("survives a server that writes non-JSON to stdout", async () => {
    // The fake server prints a log line before answering tools/list; if that
    // took down the connection, this call would never resolve.
    const client = new McpClient("fake", config);
    try {
      assert.equal((await client.listTools()).length, 3);
    } finally {
      client.close();
    }
  });

  it("fails every pending request when the server dies", async () => {
    const client = new McpClient("dead", { command: process.execPath, args: ["-e", "process.exit(1)"] });
    await assert.rejects(() => client.listTools(), /mcp server "dead"/);
    client.close();
  });
});

describe("mcp tools", () => {
  after(() => closeMcpClients());

  it("namespaces tools by server and calls through to them", async () => {
    const tools = await mcpTools({ fake: config });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["fake__echo", "fake__explode", "fake__hang"],
    );

    const echo = tools[0]!;
    // The schema has to survive the round trip the harness makes: parse the
    // model's arguments, and render back to JSON Schema for the catalog.
    assert.deepEqual(echo.schema.parse({ message: "hello" }), { message: "hello" });
    assert.throws(() => echo.schema.parse({ times: 2 }), z.ZodError);
    assert.match(JSON.stringify(z.toJSONSchema(echo.schema)), /What to echo/);

    assert.equal(await echo.run({ message: "hey", times: 2 }), "hey hey");
  });

  it("disables a broken server's tools instead of failing the run", async () => {
    const tools = await mcpTools({
      broken: { command: "definitely-not-a-real-command-x9" },
      fake: config,
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["fake__echo", "fake__explode", "fake__hang"],
      "the working server still contributes its tools",
    );
  });
});

describe("jsonSchemaToZod", () => {
  it("keeps required/optional, types, and descriptions", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        path: { type: "string", description: "where" },
        depth: { type: "integer" },
        deep: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
    });

    assert.deepEqual(schema.parse({ path: "/tmp", tags: ["a"] }), { path: "/tmp", tags: ["a"] });
    assert.throws(() => schema.parse({}), z.ZodError);
    assert.throws(() => schema.parse({ path: "/tmp", depth: "deep" }), z.ZodError);
    assert.match(JSON.stringify(z.toJSONSchema(schema)), /where/);
  });

  it("degrades unsupported constructs to unknown rather than throwing", () => {
    // A tool with a loose schema is still usable; one that throws on load is not.
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { anything: { oneOf: [{ type: "string" }, { type: "number" }] } },
    });
    assert.deepEqual(schema.parse({ anything: { nested: true } }), { anything: { nested: true } });
  });

  it("handles a schema with no properties at all", () => {
    assert.deepEqual(jsonSchemaToZod(undefined).parse({}), {});
    assert.deepEqual(jsonSchemaToZod({ type: "object" }).parse({}), {});
  });
});
