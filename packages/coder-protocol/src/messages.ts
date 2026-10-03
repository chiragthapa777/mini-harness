import { z } from "zod";

/**
 * Every message between the UI and the core. See docs/mini-coder-architecture.md.
 * Bump PROTOCOL_VERSION when a message is renamed or removed.
 */
export const PROTOCOL_VERSION = 1;

export const PermissionMode = z.enum(["default", "accept-edits", "plan", "bypass"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

// UI → core

export const InitializeParams = z.object({
  protocolVersion: z.number(),
  cwd: z.string().min(1),
  model: z.string().optional(), // "provider:model"
  mode: PermissionMode.optional(),
  resume: z.string().optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export interface InitializeResult {
  protocolVersion: number;
  sessionId: string;
  model: string;
  mode: PermissionMode;
}

export const SubmitParams = z.object({ text: z.string().min(1) });
export type SubmitParams = z.infer<typeof SubmitParams>;

export const CommandParams = z.object({
  name: z.enum(["clear", "compact", "undo", "model"]),
  arg: z.string().optional(),
});
export type CommandParams = z.infer<typeof CommandParams>;

export interface CommandResult {
  message: string;
}

// core → UI

export interface PermissionParams {
  callId: string;
  tool: string;
  input: unknown;
  reason: string;
}

export const PermissionResult = z.object({ decision: z.enum(["allow", "deny", "always"]) });
export type PermissionResult = z.infer<typeof PermissionResult>;

export type StopReason = "end_turn" | "aborted" | "max_iterations" | "token_budget" | "length" | "error";

export const CoreEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_start"), callId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_output"), callId: z.string(), chunk: z.string() }),
  z.object({ type: z.literal("tool_end"), callId: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal("usage"), inputTokens: z.number(), outputTokens: z.number() }),
  z.object({
    type: z.literal("turn_end"),
    stopReason: z.enum(["end_turn", "aborted", "max_iterations", "token_budget", "length", "error"]),
    error: z.string().optional(),
  }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
