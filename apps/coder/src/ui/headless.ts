import type { CoreEvent, PermissionMode } from "@mini-agent/coder-protocol";
import { startCore } from "./core-process.js";

export interface HeadlessOptions {
  model?: string;
  mode?: PermissionMode;
}

type TurnEnd = Extract<CoreEvent, { type: "turn_end" }>;

/**
 * `mini-coder -p "…"`: one turn, the reply on stdout, then exit. Nobody is
 * there to answer a permission prompt, so every one is denied; `--mode`
 * widens what the core allows without asking. Returns the exit code.
 */
export async function runHeadless(prompt: string, options: HeadlessOptions): Promise<number> {
  const core = startCore();

  // Ctrl+C reaches the core too, which ignores it: ending is this side's call.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void core.stop().then(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  }

  let text = "";
  const ended = new Promise<TurnEnd>((resolve) =>
    core.ui.onEvent((event) => {
      if (event.type === "text_delta") {
        text += event.text;
        process.stdout.write(event.text);
      }
      if (event.type === "turn_end") resolve(event);
    }),
  );
  core.ui.onPermission(() => ({ decision: "deny" }));

  try {
    const run = async () => {
      await core.ui.initialize({ cwd: process.cwd(), ...options });
      await core.ui.submit(prompt);
      return ended;
    };
    const end = await Promise.race([run(), core.crashed]);

    if (text && !text.endsWith("\n")) process.stdout.write("\n");
    if (end.stopReason === "end_turn") return 0;
    console.error(`mini-coder: turn stopped: ${end.error ?? end.stopReason}`);
    return 1;
  } catch (err) {
    console.error(`mini-coder: ${(err as Error).message}`);
    return 1;
  } finally {
    await core.stop();
  }
}
