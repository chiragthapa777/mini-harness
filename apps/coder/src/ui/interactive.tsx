import { render } from "ink";
import type { PermissionMode } from "@mini-agent/coder-protocol";
import { App } from "./App.js";
import { startCore } from "./core-process.js";

/** `mini-coder` with no prompt: the Ink session. Returns the exit code. */
export async function runInteractive(options: { model?: string; mode?: PermissionMode }): Promise<number> {
  // Ink reads keys in raw mode, which needs a real terminal.
  if (!process.stdin.isTTY) {
    console.error('mini-coder needs an interactive terminal. In a pipe, use: mini-coder -p "<prompt>"');
    return 1;
  }

  const core = startCore();
  try {
    const session = await Promise.race([core.ui.initialize({ cwd: process.cwd(), ...options }), core.crashed]);
    const app = render(<App ui={core.ui} session={session} cwd={process.cwd()} />, { exitOnCtrlC: false });
    let crash: Error | undefined;
    core.crashed.catch((err: Error) => {
      crash = err;
      app.unmount();
    });
    await app.waitUntilExit();
    if (crash) throw crash;
    return 0;
  } catch (err) {
    console.error(`mini-coder: ${(err as Error).message}`);
    return 1;
  } finally {
    await core.stop();
  }
}
