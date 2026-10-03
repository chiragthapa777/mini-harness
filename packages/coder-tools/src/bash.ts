import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { sep } from "node:path";
import type { Tool } from "@mini-agent/coder-core";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** SIGTERM first; whatever is still alive this long after gets SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Kept in memory per stream end; the loop caps what the model sees far lower. */
const KEEP_CHARS = 200_000;
/**
 * After the shell exits, how long to wait for its pipes to close. A command
 * that started a background process (`npm run dev &`) leaves them open
 * forever, and the call must still return.
 */
const PIPE_DRAIN_MS = 200;

const schema = z.object({
  command: z.string().min(1).describe("The command, run with bash -c"),
  timeout: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Milliseconds before the command is killed (default ${DEFAULT_TIMEOUT_MS})`),
});

/** Keeps the first and last KEEP_CHARS of a stream of chunks. */
class Collected {
  #head = "";
  #tail = "";
  #dropped = 0;

  push(chunk: string): void {
    if (this.#head.length < KEEP_CHARS) {
      const room = KEEP_CHARS - this.#head.length;
      this.#head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.#tail += chunk;
    if (this.#tail.length > KEEP_CHARS) {
      this.#dropped += this.#tail.length - KEEP_CHARS;
      this.#tail = this.#tail.slice(-KEEP_CHARS);
    }
  }

  toString(): string {
    return this.#dropped
      ? `${this.#head}\n[… ${this.#dropped} characters omitted …]\n${this.#tail}`
      : this.#head + this.#tail;
  }
}

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  description:
    "Run a shell command in the project. The working directory carries over between " +
    "calls (cd persists); environment variables do not. stdin is closed, so interactive " +
    "commands will not wait for input. Output is stdout and stderr interleaved; a " +
    "non-zero exit code is reported at the end.",
  kind: "exec",
  schema,
  async run({ command, timeout = DEFAULT_TIMEOUT_MS }, ctx) {
    ctx.signal.throwIfAborted();

    // The previous cwd may have been deleted since; fall back to the root.
    const cwd = (await stat(ctx.shell.cwd).catch(() => null))?.isDirectory() ? ctx.shell.cwd : ctx.root;

    // fd 3 reports the final working directory without mixing it into the
    // output. A command that runs `exit` never gets there; its cwd stays put.
    const script = `${command}\n__mini_coder_status=$?\nprintf '%s' "$PWD" >&3\nexit $__mini_coder_status\n`;

    const child = spawn("bash", ["-c", script], {
      cwd,
      // Its own process group, so a kill reaches everything it started.
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });

    const output = new Collected();
    let finalCwd = "";
    let timedOut = false;

    const onChunk = (text: string) => {
      output.push(text);
      ctx.onOutput(text);
    };
    // Decoded by the stream, so a character split across two chunks survives.
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", onChunk);
    }
    const cwdPipe = child.stdio[3] as NodeJS.ReadableStream;
    cwdPipe.setEncoding("utf8");
    cwdPipe.on("data", (text: string) => (finalCwd += text));

    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        return; // already gone
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // gone in the meantime
        }
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeout);
    const onAbort = () => killGroup();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const finish = () => {
        if (!exited) return;
        for (const stream of [child.stdout, child.stderr, child.stdio[3]]) {
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        }
        resolve(exited);
      };
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        setTimeout(finish, PIPE_DRAIN_MS).unref();
      });
      child.on("close", finish);
    }).finally(() => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      ctx.signal.removeEventListener("abort", onAbort);
    });

    if (ctx.signal.aborted) throw ctx.signal.reason;

    let note = "";
    if (finalCwd) {
      if (finalCwd === ctx.root || finalCwd.startsWith(ctx.root + sep)) {
        ctx.shell.cwd = finalCwd;
      } else {
        ctx.shell.cwd = ctx.root;
        note = `\n[the working directory left the project; it was reset to ${ctx.root}]`;
      }
    }

    const text = output.toString() || "(no output)";
    if (timedOut) {
      throw new Error(`${text}\n[timed out after ${timeout / 1000}s; the command was killed]`);
    }
    const status =
      exit.code === 0 ? "" : exit.code === null ? `\n[killed by ${exit.signal}]` : `\n[exit code ${exit.code}]`;
    return `${text}${status}${note}`;
  },
};
