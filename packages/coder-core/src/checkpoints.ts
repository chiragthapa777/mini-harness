import { readFile, rm, writeFile } from "node:fs/promises";

/**
 * File snapshots for `/undo`, one group per user turn.
 *
 * A file is saved once per turn, before its first change, so undo restores
 * the state at the start of the turn however many edits followed. A file that
 * did not exist is recorded as `null` and removed on undo. Only changes made
 * through file tools are covered — a command run through bash is not.
 */
export class Checkpoints {
  readonly #turns: Map<string, Buffer | null>[] = [];

  /** Opens the group for a new user turn. */
  begin(): void {
    this.#turns.push(new Map());
  }

  async save(path: string): Promise<void> {
    const turn = this.#turns.at(-1);
    if (!turn || turn.has(path)) return;
    try {
      turn.set(path, await readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      turn.set(path, null);
    }
  }

  /** Restores the most recent turn that changed files; returns the paths it touched. */
  async undo(): Promise<string[]> {
    while (this.#turns.length) {
      const turn = this.#turns.pop()!;
      if (turn.size === 0) continue;

      for (const [path, content] of turn) {
        if (content === null) await rm(path, { force: true });
        else await writeFile(path, content);
      }
      return [...turn.keys()];
    }
    return [];
  }

  clear(): void {
    this.#turns.length = 0;
  }
}
