import type { Core, CoreMessage } from "@mini-agent/coder-core/wire";

type TurnEnd = Extract<CoreMessage, { type: "turn_end" }>;

/**
 * `mini-coder -p "…"`: one turn, the reply on stdout, then exit. Nobody is
 * there to answer a permission prompt, so every one is denied; `--mode`
 * widens what the core allows without asking. Returns the exit code.
 */
export async function runHeadless(prompt: string, core: Core): Promise<number> {
  // Stop the turn first, so a running bash command is killed with us.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void core.stop().then(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  }

  let text = "";
  const ended = new Promise<TurnEnd>((resolve) =>
    core.onMessage((message) => {
      if (message.type === "text_delta") {
        text += message.text;
        process.stdout.write(message.text);
      }
      if (message.type === "permission_request") {
        core.send({ type: "permission_answer", callId: message.callId, decision: "deny" });
      }
      if (message.type === "turn_end") resolve(message);
    }),
  );

  core.send({ type: "submit", text: prompt });
  const end = await ended;

  if (text && !text.endsWith("\n")) process.stdout.write("\n");
  if (end.stopReason === "end_turn") return 0;
  console.error(`mini-coder: turn stopped: ${end.error ?? end.stopReason}`);
  return 1;
}
