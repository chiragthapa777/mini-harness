import { render } from "ink";
import type { Core } from "@mini-agent/coder-core/wire";
import { App } from "./App.js";

/** `mini-coder` with no prompt: the Ink session. Returns the exit code. */
export async function runInteractive(core: Core): Promise<number> {
  // Ink reads keys in raw mode, which needs a real terminal.
  if (!process.stdin.isTTY) {
    console.error('mini-coder needs an interactive terminal. In a pipe, use: mini-coder -p "<prompt>"');
    return 1;
  }

  // Ink keeps console output above its own drawing, and restores the terminal
  // however the process ends.
  const app = render(<App core={core} cwd={process.cwd()} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  await core.stop();
  return 0;
}
