import { parseArgs } from "node:util";
import { PERMISSION_MODES, type PermissionMode } from "@mini-agent/coder-core";
import { startCore } from "./core.js";
import { runHeadless } from "./ui/headless.js";

/**
 * Entry point of the `mini-coder` command: builds the core, then hands it to
 * one of the two UIs. Everything runs in this process.
 */
const USAGE = `usage:
  mini-coder [--model provider:model] [--mode …]     interactive session
  mini-coder -p "<prompt>" [--model provider:model] [--mode ${PERMISSION_MODES.join("|")}]
  --resume    continue the most recent session in this folder`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function readArgs() {
  try {
    return parseArgs({
      options: {
        print: { type: "string", short: "p" },
        model: { type: "string" },
        mode: { type: "string" },
        resume: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    fail(`mini-coder: ${(err as Error).message}\n${USAGE}`);
  }
}

const { values, positionals } = readArgs();
if (positionals.length > 0) fail(`mini-coder: unexpected argument "${positionals[0]}"\n${USAGE}`);

const mode = values.mode as PermissionMode | undefined;
if (mode !== undefined && !PERMISSION_MODES.includes(mode)) fail(`mini-coder: unknown mode "${mode}"\n${USAGE}`);

const core = await startCore({ cwd: process.cwd(), model: values.model, mode, resume: values.resume }).catch(
  (err: Error): never => fail(`mini-coder: ${err.message}`),
);

if (values.print !== undefined) {
  process.exitCode = await runHeadless(values.print, core);
} else {
  // Loaded on demand: `-p` never needs Ink or React.
  const { runInteractive } = await import("./ui/interactive.js");
  process.exitCode = await runInteractive(core);
}
// MCP servers are child processes: left running, they would keep this one alive.
await core.stop();
