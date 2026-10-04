import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Msg } from "@mini-agent/llm";
import { z } from "zod";
import type { Tool } from "./tool.js";
import type { CoreMessage } from "./wire.js";

/**
 * The session log: one file per session, one JSON line per turn, under
 * `<home>/projects/<slug>/sessions/`. It is both halves of a resume — what
 * the screen showed and what the model was told — and what `recall` searches.
 */
export interface SessionRecord {
  at: string; // ISO time
  /** What the UI showed, for replay: the user's text, reply text, tool cards, how the turn ended. */
  messages: CoreMessage[];
  /** What this turn added to the model's history. */
  history: Msg[];
  /** The history starts over with this record: `/clear`, or a compaction's summary. */
  reset?: boolean;
}

const MAX_HITS = 10;

/** Everything mini-coder keeps about a project lives outside it, in a folder named after its path. */
export function projectFolder(home: string, root: string): string {
  return join(home, "projects", root.replaceAll("/", "-"));
}

/**
 * The log file for this run: a new one, or with `resume` the project's most
 * recent. Names start with the time, so sorting by name is sorting by age.
 */
export function sessionFile(home: string, root: string, resume: boolean): string {
  const folder = join(projectFolder(home, root), "sessions");
  if (!resume) {
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    return join(folder, `${time}-${randomUUID().slice(0, 8)}.jsonl`);
  }
  const latest = sessionFiles(folder).at(-1);
  if (!latest) throw new Error("no earlier session in this folder to resume");
  return latest;
}

function sessionFiles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(folder, name));
  } catch {
    return [];
  }
}

/** A missing file is an empty session. A line that is not JSON (a write cut short) is skipped. */
export function readRecords(file: string): SessionRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as SessionRecord] : [];
    } catch {
      return [];
    }
  });
}

export async function appendRecord(file: string, record: Omit<SessionRecord, "at">): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

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

/** Searches the turns of every session logged in `folder`, newest first. */
export function recallTool(folder: string): Tool<typeof recallSchema> {
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

      for (const file of sessionFiles(folder).reverse()) {
        for (const record of readRecords(file).reverse()) {
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
