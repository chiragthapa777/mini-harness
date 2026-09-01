import { getConfig } from "@mini-agent/config";
import type { z } from "zod";
import { McpClient, type McpServerConfig } from "./client.js";
import { jsonSchemaToZod } from "./schema.js";

/**
 * MCP tools, rendered as the harness's own tools.
 *
 * There is no provider-native function calling anywhere in this project: the
 * agent asks for a tool by emitting a ```tool_call fence and the harness parses
 * it. An MCP tool therefore has to arrive as an ordinary `AgentTool` — same
 * catalog, same fence, same trace — or it would be a second tool-calling path
 * with its own failure modes.
 *
 * The shape is declared structurally rather than imported from
 * `@mini-agent/core`, which would make the dependency circular: core owns the
 * loop, and the loop must not know MCP exists.
 */
export interface McpAgentTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run(input: unknown): Promise<string>;
}

/** Process-wide, because a client owns a child process and a handshake. */
const clients = new Map<string, McpClient>();

export function mcpClient(name: string, config: McpServerConfig): McpClient {
  const existing = clients.get(name);
  if (existing) return existing;

  const client = new McpClient(name, config);
  clients.set(name, client);
  return client;
}

/**
 * Connect to every configured server and return their tools.
 *
 * A server that fails to start contributes no tools and does not fail the
 * run — an agent with three of its four tool sets is useful; an agent that
 * refuses to answer because a side-car crashed is not.
 */
export async function mcpTools(
  servers: Record<string, McpServerConfig> = getConfig().mcp.servers,
): Promise<McpAgentTool[]> {
  const collected = await Promise.all(
    Object.entries(servers).map(([name, config]) => toolsFrom(name, config)),
  );
  return collected.flat();
}

async function toolsFrom(name: string, config: McpServerConfig): Promise<McpAgentTool[]> {
  const client = mcpClient(name, config);

  try {
    const definitions = await client.listTools();

    return definitions.map((definition) => ({
      // Namespaced: two servers may each publish a `search`, and the model
      // picks tools by name alone.
      name: `${name}__${definition.name}`,
      description: definition.description ?? `${definition.name} (via the ${name} MCP server)`,
      schema: jsonSchemaToZod(definition.inputSchema),
      run: (input: unknown) => client.callTool(definition.name, input),
    }));
  } catch (err) {
    console.warn(
      `[mcp] server "${name}" unavailable, its tools are disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/** Shut every server down — for a process that wants to exit promptly. */
export function closeMcpClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
