import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, UiEndpoint } from "@mini-agent/coder-protocol";

/** How long the core gets to exit after `shutdown` before it is killed. */
const SHUTDOWN_GRACE_MS = 2_000;

export interface CoreProcess {
  ui: UiEndpoint;
  logFile: string;
  /** Rejects when the core exits without `stop()` having been called. */
  crashed: Promise<never>;
  /** Asks the core to shut down, kills it if it does not, and waits for it to be gone. */
  stop(): Promise<void>;
}

/**
 * Spawns the core as a child of this process: the same command, run as
 * `serve`. The pipes are the lifecycle link — if this process dies, the
 * core's stdin closes and it shuts down.
 */
export function startCore(): CoreProcess {
  const logDir = join(homedir(), ".mini-coder", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);
  const log = openSync(logFile, "a");

  // execArgv carries the TypeScript loader when running from source; the
  // bundle has none.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "serve"], {
    stdio: ["pipe", "pipe", log],
  });
  closeSync(log); // the child has its own copy

  const exited = new Promise<string>((resolve) => {
    child.on("error", (err) => resolve(err.message));
    child.on("exit", (code, signal) => resolve(signal ? `signal ${signal}` : `code ${code}`));
  });

  let stopping = false;
  const crashed = new Promise<never>((_, reject) => {
    void exited.then((how) => {
      if (!stopping) reject(new Error(`the core exited unexpectedly (${how}); see ${logFile}`));
    });
  });
  crashed.catch(() => {}); // callers that never race it must not crash the process

  const ui = new UiEndpoint(new Connection(child.stdout!, child.stdin!));

  return {
    ui,
    logFile,
    crashed,
    async stop() {
      stopping = true;
      const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
      ui.shutdown().catch(() => child.kill("SIGKILL")); // already gone, or not answering
      await exited;
      clearTimeout(timer);
    },
  };
}
