import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadMemory,
  loadSettings,
  Session,
  sessionFile,
  type Core,
  type CoreMessage,
  type PermissionMode,
} from "@mini-agent/coder-core";
import { defaultTools } from "@mini-agent/coder-tools";
import { chatModel } from "@mini-agent/llm";
import { connectMcp } from "./mcp.js";

/** Output-token ceiling per model call. */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Builds the core for a UI to drive — the one file that imports coder-core,
 * coder-tools and llm together, reads settings and memory from disk, and
 * starts the MCP servers.
 * Flags win over settings. `resume` continues the folder's latest session.
 * Throws when the folder, the model or a settings file is not usable, or
 * there is nothing to resume.
 */
export async function startCore(options: {
  cwd: string;
  model?: string;
  mode?: PermissionMode;
  resume?: boolean;
}): Promise<Core> {
  // The session speaks as soon as it exists; keep that until the UI listens.
  const early: CoreMessage[] = [];
  let handler = (message: CoreMessage): void => void early.push(message);

  const home = join(homedir(), ".mini-coder");
  const root = realpathSync(options.cwd);
  const settings = loadSettings(home, root);
  const memory = loadMemory(home, root);
  const logFile = sessionFile(home, root, options.resume ?? false);
  const mcp = await connectMcp(settings.mcpServers ?? {});

  let session: Session;
  try {
    session = new Session((message) => handler(message), {
      cwd: root,
      model: options.model ?? settings.model,
      mode: options.mode ?? settings.mode,
      rules: settings.permissions,
      memory: memory.prompt,
      skills: memory.skills,
      logFile,
      tools: [...defaultTools, ...memory.tools, ...mcp.tools],
      createModel: ({ provider, model }) =>
        chatModel(provider, model, MAX_OUTPUT_TOKENS, settings.providers?.[provider]),
    });
  } catch (err) {
    mcp.close(); // do not leave the servers running
    throw err;
  }

  for (const text of mcp.problems) handler({ type: "notice", text, isError: true });

  return {
    send: (message) => session.receive(message),
    onMessage(next) {
      handler = next;
      for (const message of early.splice(0)) next(message);
    },
    async stop() {
      await session.stop();
      mcp.close();
    },
  };
}
