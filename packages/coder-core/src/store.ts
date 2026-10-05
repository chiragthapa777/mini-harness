import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Msg } from "@mini-agent/llm";
import type { CoreMessage, SettingsScope } from "./wire.js";

/**
 * The persistence layer. Every file mini-coder keeps about itself is read or
 * written here and nowhere else, so this file is the whole list of what
 * lands on disk. It moves plain text and records; what they mean (checking
 * settings, building the prompt, searching sessions) is up to the caller.
 *
 * `home` is `~/.mini-coder`; `root` is the project, already resolved.
 *
 *   <home>/settings.json                          user settings          read, write
 *   <home>/AGENTS.md                              user rules             read
 *   <home>/MEMORY.md                              user facts             read, append
 *   <home>/skills/<name>/SKILL.md                 user skills            read
 *   <home>/projects/<slug>/settings.json          local settings         read, write
 *   <home>/projects/<slug>/MEMORY.md              project facts          read, append
 *   <home>/projects/<slug>/sessions/<time>-<id>.jsonl  session logs      read, append
 *   <root>/AGENTS.md                              project rules          read
 *   <root>/.mini-coder/settings.json              repository settings    read
 *   <root>/.mini-coder/skills/<name>/SKILL.md     project skills         read
 *
 * mini-coder writes only under `<home>`, never into the project, so nothing
 * it saves is committed and a cloned repository cannot bring any of it along.
 *
 * Rules: a missing file reads as "". A write creates its folder. A whole-file
 * write goes to a temporary file and is renamed into place, so a crash cannot
 * leave half a file. Appends add whole lines.
 */

/** A settings file: the two mini-coder writes, and the repository's, which it only reads. */
export type SettingsSource = SettingsScope | "repo";

export class Store {
  constructor(
    readonly home: string,
    readonly root: string,
  ) {}

  /** Everything kept about one project, in a folder named after its path: "/" → "-". */
  private get projectFolder(): string {
    return join(this.home, "projects", this.root.replaceAll("/", "-"));
  }

  private get sessionsFolder(): string {
    return join(this.projectFolder, "sessions");
  }

  // Settings

  settingsPath(source: SettingsSource): string {
    if (source === "repo") return join(this.root, ".mini-coder", "settings.json");
    return join(source === "user" ? this.home : this.projectFolder, "settings.json");
  }

  readSettings(source: SettingsSource): string {
    return read(this.settingsPath(source));
  }

  async writeSettings(scope: SettingsScope, settings: object): Promise<void> {
    await replace(this.settingsPath(scope), JSON.stringify(settings, null, 2) + "\n");
  }

  // Memory

  /** AGENTS.md: the user's, then the project's. */
  readRules(): string[] {
    return [read(join(this.home, "AGENTS.md")), read(join(this.root, "AGENTS.md"))];
  }

  readFacts(scope: SettingsScope): string {
    return read(this.factsPath(scope));
  }

  async appendFact(scope: SettingsScope, fact: string): Promise<void> {
    await appendLine(this.factsPath(scope), `- ${fact}`);
  }

  /** Every SKILL.md: the user's, then the project's. The folder is the name. */
  readSkills(): { name: string; text: string }[] {
    return [join(this.home, "skills"), join(this.root, ".mini-coder", "skills")].flatMap((folder) =>
      list(folder).map((name) => ({ name, text: read(join(folder, name, "SKILL.md")) })),
    );
  }

  private factsPath(scope: SettingsScope): string {
    return join(scope === "user" ? this.home : this.projectFolder, "MEMORY.md");
  }

  // Sessions

  /**
   * The log for this run: a new one, or with `resume` the project's most
   * recent. Names start with the time, so sorting by name is sorting by age.
   */
  openSession(resume: boolean): SessionLog {
    if (!resume) {
      const time = new Date().toISOString().replace(/[:.]/g, "-");
      return new SessionLog(join(this.sessionsFolder, `${time}-${randomUUID().slice(0, 8)}.jsonl`));
    }
    const latest = this.sessionLogs().at(-1);
    if (!latest) throw new Error("no earlier session in this folder to resume");
    return latest;
  }

  /** Every logged session of this project, oldest first. */
  sessionLogs(): SessionLog[] {
    return list(this.sessionsFolder)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => new SessionLog(join(this.sessionsFolder, name)));
  }
}

/**
 * One line per turn: both halves of a resume — what the screen showed and
 * what the model was told — and what `recall` searches.
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

/** One session's log file. */
export class SessionLog {
  constructor(readonly file: string) {}

  /** A missing file is an empty session. A line that is not JSON (a write cut short) is skipped. */
  read(): SessionRecord[] {
    return read(this.file)
      .split("\n")
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as SessionRecord] : [];
        } catch {
          return [];
        }
      });
  }

  async append(record: Omit<SessionRecord, "at">): Promise<void> {
    await appendLine(this.file, JSON.stringify({ at: new Date().toISOString(), ...record }));
  }
}

// The only file system calls in this layer.

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function list(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, line + "\n");
}

async function replace(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}
