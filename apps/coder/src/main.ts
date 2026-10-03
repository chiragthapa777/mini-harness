import { parseArgs } from "node:util";
import { PermissionMode } from "@mini-agent/coder-protocol";
import { runServe } from "./serve.js";
import { runHeadless } from "./ui/headless.js";

/**
 * Entry point of the `mini-coder` command. One file, two roles: `serve` is
 * the core process; anything else is a UI that spawns it. The interactive UI
 * arrives in phase 4.
 */
const USAGE = `usage:
  mini-coder -p "<prompt>" [--model provider:model] [--mode ${PermissionMode.options.join("|")}]
  mini-coder serve          (the core over stdio; UIs spawn this)`;

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
      },
      allowPositionals: true,
    });
  } catch (err) {
    fail(`mini-coder: ${(err as Error).message}\n${USAGE}`);
  }
}

const { values, positionals } = readArgs();

if (positionals[0] === "serve") {
  runServe();
} else if (values.print) {
  const mode = PermissionMode.optional().safeParse(values.mode);
  if (!mode.success) fail(`mini-coder: unknown mode "${values.mode}"\n${USAGE}`);
  process.exitCode = await runHeadless(values.print, { model: values.model, mode: mode.data });
} else {
  fail(USAGE);
}
