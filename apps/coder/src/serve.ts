import type { Readable, Writable } from "node:stream";
import { DEFAULT_MODEL, Session } from "@mini-agent/coder-core";
import { Connection, CoreEndpoint } from "@mini-agent/coder-protocol";
import { defaultTools } from "@mini-agent/coder-tools";
import { chatModel } from "@mini-agent/llm";

/**
 * The composition root of the core process — the one file that imports
 * coder-core, coder-tools and llm together and wires them. The UI never
 * imports this; it spawns `mini-coder serve` and talks to it over stdio.
 */

/** Output-token ceiling per model call. */
const MAX_OUTPUT_TOKENS = 16_000;

export function serve(input: Readable, output: Writable, onExit: () => void): Session {
  return new Session(new CoreEndpoint(new Connection(input, output)), {
    tools: defaultTools,
    createModel: ({ provider, model }) => chatModel(provider, model, MAX_OUTPUT_TOKENS),
    defaultModel: DEFAULT_MODEL,
    onShutdown: onExit,
  });
}

/** `mini-coder serve`: the core on this process's stdin/stdout. */
export function runServe(): void {
  // stdout carries protocol messages only. Anything that logs — this code, a
  // dependency — goes to stderr, which the UI sends to a log file.
  console.log = console.info = console.debug = console.error;

  // Ctrl+C reaches every process in the terminal's foreground group, this one
  // included. Interrupting is the UI's decision; it tells us with `abort` or
  // `shutdown`. A person who ran `serve` by hand has no UI, so Ctrl+C stays theirs.
  if (process.stdin.isTTY) {
    console.error('mini-coder serve: the core, no UI. It speaks JSON-RPC on stdin/stdout. Ctrl+C to quit; use `mini-coder -p "…"` to run a prompt.');
  } else {
    process.on("SIGINT", () => {});
  }

  let exiting = false;
  const exit = (code = 0) => {
    if (exiting) return;
    exiting = true;
    // Let the last reply reach the pipe before the process goes.
    process.stdout.write("", () => process.exit(code));
  };

  const session = serve(process.stdin, process.stdout, () => exit(0));
  process.on("SIGTERM", () => {
    void session.stop().finally(() => exit(0));
  });
  process.on("uncaughtException", (err) => {
    console.error("[mini-coder serve] fatal:", err);
    exit(1);
  });
}
