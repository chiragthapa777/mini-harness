import type { Tool } from "@mini-agent/coder-core";
import { jsonSchemaToZod, McpClient, type McpServerConfig } from "@mini-agent/mcp";

/**
 * Starts the configured MCP servers and offers their tools as ours, named
 * `server__tool`. What such a tool does is unknown, so each one is a command
 * to the permission gate: it asks first. A server that does not start is
 * reported in `problems` and contributes nothing.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>) {
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  const problems: string[] = [];

  await Promise.all(
    Object.entries(servers).map(async ([server, config]) => {
      const client = new McpClient(server, config);
      clients.push(client);
      try {
        for (const definition of await client.listTools()) {
          tools.push({
            name: `${server}__${definition.name}`,
            description: definition.description ?? `${definition.name} (from the ${server} MCP server)`,
            schema: jsonSchemaToZod(definition.inputSchema),
            kind: "exec",
            // The server cannot be told to stop; on Esc we stop waiting for it.
            run: (input, { signal }) =>
              Promise.race([
                client.callTool(definition.name, input),
                new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
              ]),
          });
        }
      } catch (err) {
        problems.push(`MCP server "${server}" is unavailable: ${(err as Error).message}`);
      }
    }),
  );

  // Servers answer in any order; the tool catalog is part of the cached prompt.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, problems, close: () => clients.forEach((client) => client.close()) };
}
