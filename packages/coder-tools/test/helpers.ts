import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@mini-agent/coder-core";

export async function tempProject(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "coder-tools-")));
}

/** A tool context as the session builds it, with every side channel recorded. */
export function context(root: string, overrides: Partial<ToolContext> = {}) {
  const output: string[] = [];
  const checkpoints: string[] = [];
  const ctx: ToolContext = {
    root,
    signal: new AbortController().signal,
    onOutput: (chunk) => output.push(chunk),
    reads: new Map(),
    checkpoint: async (path) => {
      checkpoints.push(path);
    },
    shell: { cwd: root },
    ...overrides,
  };
  return { ctx, output, checkpoints };
}
