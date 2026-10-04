import type { z } from "zod";

/**
 * What the permission gate needs to know about a tool without knowing the
 * tool: reads are allowed by default, writes and exec ask.
 */
export type ToolKind = "read" | "write" | "exec";

/** Everything a tool may touch beyond its own input. Built by the session, one per call. */
export interface ToolContext {
  /** The project root, already resolved with realpath. File tools are confined to it. */
  root: string;
  /** Fires on Esc or shutdown. A tool must stop promptly — kill children, stop reading. */
  signal: AbortSignal;
  /** Streams partial output to the UI (bash prints as it runs). The final result is still the return value. */
  onOutput(chunk: string): void;
  /** Files read this session: realpath → mtime when read. Edits require a matching entry. */
  reads: Map<string, number>;
  /** Saves a file's current content before its first change this turn, for `/undo`. */
  checkpoint(path: string): Promise<void>;
  /** The shell's working directory, carried between `bash` calls. */
  shell: { cwd: string };
}

export interface Tool<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  kind: ToolKind;
  /** Returns the text the model sees. Throwing reports an error result; it does not end the turn. */
  run(input: z.infer<S>, context: ToolContext): Promise<string>;
}
