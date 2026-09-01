/**
 * A minimal MCP server over stdio, for the client tests.
 *
 * Real enough to exercise the protocol — handshake, tools/list, tools/call,
 * an error result, and a tool that never answers — without depending on a
 * published server or a network.
 */
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to echo" },
        times: { type: "integer", description: "How many times" },
      },
      required: ["message"],
    },
  },
  {
    name: "explode",
    description: "Always returns an error result",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hang",
    description: "Never replies",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const message = JSON.parse(trimmed);
  if (message.method === "notifications/initialized") return;

  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });

  switch (message.method) {
    case "initialize":
      // A real server logs to stderr during startup; make sure that does not
      // confuse the client.
      process.stderr.write("fake server ready\n");
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0.0.0" },
      });
      return;

    case "tools/list":
      // Servers that log to stdout are common enough to be worth surviving.
      process.stdout.write("this line is not JSON\n");
      reply({ tools: TOOLS });
      return;

    case "tools/call": {
      const { name, arguments: args } = message.params ?? {};
      if (name === "explode") {
        reply({ content: [{ type: "text", text: "it blew up" }], isError: true });
        return;
      }
      if (name === "hang") return; // deliberately no reply
      if (name === "echo") {
        const times = typeof args?.times === "number" ? args.times : 1;
        reply({
          content: [{ type: "text", text: Array(times).fill(args?.message ?? "").join(" ") }],
        });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown tool: ${name}` } });
      return;
    }

    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
