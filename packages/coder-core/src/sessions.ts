import { z } from "zod";
import type { SessionLog } from "./store.js";
import type { Tool } from "./tool.js";
import type { CoreMessage } from "./wire.js";

/**
 * What a session log holds and how it is searched. Reading and writing the
 * logs is the store's job (store.ts).
 */

const MAX_HITS = 10;

/** Keeps what a replay needs from a turn's messages, with the streamed text joined up. */
export function keepForReplay(kept: CoreMessage[], message: CoreMessage): void {
  const last = kept.at(-1);
  if (message.type === "text_delta" && last?.type === "text_delta") last.text += message.text;
  else if (message.type === "text_delta") kept.push({ ...message }); // a copy: the UI holds the original
  else if (message.type === "tool_start" || message.type === "tool_end") kept.push(message);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const recallSchema = z.object({
  query: z.string().min(1).describe("Words to look for; a turn matches when it contains all of them"),
});

/** Searches the turns of every session in `logs` (oldest first), newest first. */
export function recallTool(logs: () => SessionLog[]): Tool<typeof recallSchema> {
  return {
    name: "recall",
    description:
      "Search earlier sessions in this project for what was asked and answered. Use it when the user " +
      "refers to past work that is not in this conversation.",
    kind: "read",
    schema: recallSchema,
    // ponytail: reads every log on each call and matches plain words. Upgrade:
    // an index with a title and summary per session, searched first.
    async run({ query }) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: string[] = [];

      for (const log of logs().reverse()) {
        for (const record of log.read().reverse()) {
          const asked = record.messages.flatMap((m) => (m.type === "user" ? [m.text] : [])).join("\n");
          const answered = record.messages.flatMap((m) => (m.type === "text_delta" ? [m.text] : [])).join("").trim();
          const text = `${asked}\n${answered}`.toLowerCase();
          if (!asked || !words.every((word) => text.includes(word))) continue;

          hits.push(`[${record.at.slice(0, 10)}] user: ${clip(asked, 300)}\nassistant: ${clip(answered, 600)}`);
          if (hits.length === MAX_HITS) return hits.join("\n\n");
        }
      }
      return hits.join("\n\n") || `nothing in earlier sessions matches "${query}"`;
    },
  };
}
