import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Tool } from "@mini-agent/coder-core";
import { z } from "zod";

const DEFAULT_TIMEOUT = 120_000;
const MAX_KEPT_OUTPUT = 5_000_000; // characters; the loop shows far less to the model

const schema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().min(1_000).max(600_000).optional().describe("milliseconds, default 120000"),
});

/** Folders under the home folder that package managers must be able to write to. */
const WRITABLE_IN_HOME = [".npm", ".cache", ".pnpm-store", "Library/Caches", "Library/pnpm"];

/**
 * The command line that runs bash confined by the operating system: it may
 * write only inside the project, temp folders and package-manager caches, and
 * may not read `~/.ssh` or `~/.mini-coder`. The network stays open.
 * ponytail: macOS only (`sandbox-exec`). On other systems it refuses to run
 * rather than run unconfined. Upgrade: bubblewrap on Linux.
 */
function sandboxed(root: string): string[] {
  if (process.platform !== "darwin") {
    throw new Error("the bash sandbox only works on macOS so far; turn `sandbox` off in settings to run commands");
  }
  const home = homedir();
  const paths = (folders: string[]) => folders.map((folder) => `(subpath ${JSON.stringify(folder)})`).join(" ");
  const writable = [root, realpathSync(tmpdir()), "/private/tmp", "/dev", ...WRITABLE_IN_HOME.map((f) => join(home, f))];
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${paths(writable)})`,
    `(deny file-read* file-write* ${paths([join(home, ".ssh"), join(home, ".mini-coder")])})`,
  ].join("\n");
  return ["sandbox-exec", "-p", profile, "bash"];
}

export const bashTool = createBashTool();

export function createBashTool({ sandbox = false } = {}): Tool<typeof schema> {
  return {
    name: "bash",
    description:
      "Run a shell command in the project. `cd` carries over to the next call; environment " +
      "variables do not. stdin is closed. A non-zero exit code is shown after the output.",
    kind: "exec",
    schema,
    async run({ command, timeout = DEFAULT_TIMEOUT }, ctx) {
      ctx.signal.throwIfAborted();

      // Start where the last command ended, unless that folder is gone.
      const folder = await stat(ctx.shell.cwd).catch(() => null);
      const cwd = folder?.isDirectory() ? ctx.shell.cwd : ctx.root;

      // After the command, bash writes its working directory to file descriptor 3,
      // so we learn where a `cd` went without mixing it into the output.
      const script = `${command}\n__status=$?\nprintf '%s' "$PWD" >&3\nexit $__status\n`;
      const [program = "bash", ...args] = sandbox ? sandboxed(ctx.root) : ["bash"];
      const child = spawn(program, [...args, "-c", script], {
        cwd,
        detached: true, // its own process group, so we can kill everything it started
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });

      let output = "";
      let newCwd = "";
      let timedOut = false;

      for (const stream of [child.stdout!, child.stderr!]) {
        stream.setEncoding("utf8"); // keeps characters split across chunks intact
        stream.on("data", (text: string) => {
          ctx.onOutput(text);
          if (output.length < MAX_KEPT_OUTPUT) output += text;
        });
      }
      const cwdPipe = child.stdio[3] as NodeJS.ReadableStream;
      cwdPipe.setEncoding("utf8");
      cwdPipe.on("data", (text: string) => (newCwd += text));

      const killAll = () => {
        try {
          process.kill(-child.pid!, "SIGKILL"); // minus: the whole process group
        } catch {
          // already exited
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killAll();
      }, timeout);
      ctx.signal.addEventListener("abort", killAll);

      const exitCode = await waitForExit(child);
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", killAll);

      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (timedOut) throw new Error(`${output}\n[timed out after ${timeout / 1000}s and was killed]`);

      let note = "";
      if (newCwd === ctx.root || newCwd.startsWith(ctx.root + sep)) {
        ctx.shell.cwd = newCwd;
      } else if (newCwd) {
        ctx.shell.cwd = ctx.root;
        note = `\n[the working directory left the project and was reset to ${ctx.root}]`;
      }

      const status = exitCode === 0 ? "" : `\n[exit code ${exitCode ?? "none: killed"}]`;
      return (output || "(no output)") + status + note;
    },
  };
}

/**
 * Resolves with the exit code once the output is read. A command that left a
 * background job running (`npm run dev &`) keeps the pipes open forever, so
 * after the exit we wait at most a moment for them.
 */
function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
    child.on("exit", (code) => setTimeout(() => resolve(code), 200));
  });
}
