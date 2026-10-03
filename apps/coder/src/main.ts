import { parseArgs } from "node:util";
import { PermissionMode } from "@mini-agent/coder-protocol";
import { runServe } from "./serve.js";
import { runHeadless } from "./ui/headless.js";

/**
 * Entry point of the `mini-coder` command. One file, two roles: `serve` is
 * the core process; anything else is a UI that spawns it.
 */
const USAGE = `usage:
  mini-coder [--model provider:model] [--mode …]     interactive session
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
} else {
  if (positionals.length > 0) fail(`mini-coder: unexpected argument "${positionals[0]}"\n${USAGE}`);
  const mode = PermissionMode.optional().safeParse(values.mode);
  if (!mode.success) fail(`mini-coder: unknown mode "${values.mode}"\n${USAGE}`);
  const options = { model: values.model, mode: mode.data };

  if (values.print !== undefined) {
    process.exitCode = await runHeadless(values.print, options);
  } else {
    // Loaded on demand: the core and `-p` never need Ink or React.
    const { runInteractive } = await import("./ui/interactive.js");
    process.exitCode = await runInteractive(options);
  }
}
