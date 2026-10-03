import { z } from "zod";

/**
 * Every message the UI and the core exchange. One file, so the contract is
 * readable in one sitting — see `docs/mini-coder-architecture.md`.
 *
 * Adding a method, an event type, or an optional field is backwards
 * compatible. Renaming or removing anything is not, and bumps this number;
 * `initialize` refuses a client built against a different one.
 */
export const PROTOCOL_VERSION = 1;

export const PERMISSION_MODES = ["default", "accept-edits", "plan", "bypass"] as const;
export const PermissionMode = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionMode>;

// --- UI → core requests ----------------------------------------------------

export const InitializeParams = z.object({
  protocolVersion: z.number().int(),
  /** The project root. Every file tool is confined to it. */
  cwd: z.string().min(1),
  /** `provider:model`, e.g. `openrouter:z-ai/glm-5.3-flash`. Omitted: the core's default. */
  model: z.string().min(1).optional(),
  mode: PermissionMode.optional(),
  /** A session id to resume. */
  resume: z.string().min(1).optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const InitializeResult = z.object({
  protocolVersion: z.number().int(),
  sessionId: z.string(),
  model: z.string(),
  mode: PermissionMode,
});
export type InitializeResult = z.infer<typeof InitializeResult>;

export const SubmitParams = z.object({ text: z.string().min(1) });
export type SubmitParams = z.infer<typeof SubmitParams>;

export const COMMANDS = ["clear", "compact", "undo", "model"] as const;
export const CommandParams = z.object({
  name: z.enum(COMMANDS),
  arg: z.string().optional(),
});
export type CommandParams = z.infer<typeof CommandParams>;

export const CommandResult = z.object({ message: z.string() });
export type CommandResult = z.infer<typeof CommandResult>;

export const Empty = z.object({});
export type Empty = z.infer<typeof Empty>;

// --- core → UI requests ----------------------------------------------------

export const PermissionParams = z.object({
  callId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  /** Why the gate asked — shown to the user next to the call. */
  reason: z.string(),
});
export type PermissionParams = z.infer<typeof PermissionParams>;

export const DECISIONS = ["allow", "deny", "always"] as const;
export const PermissionResult = z.object({ decision: z.enum(DECISIONS) });
export type PermissionResult = z.infer<typeof PermissionResult>;

// --- core → UI events ------------------------------------------------------

export const STOP_REASONS = [
  "end_turn",
  "aborted",
  "max_iterations",
  "token_budget",
  /** The model ran out of output tokens mid-reply. */
  "length",
  "error",
] as const;
export const StopReason = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReason>;

export const CoreEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  z.object({
    type: z.literal("tool_start"),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ type: z.literal("tool_output"), callId: z.string(), chunk: z.string() }),
  z.object({
    type: z.literal("tool_end"),
    callId: z.string(),
    output: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  z.object({
    type: z.literal("turn_end"),
    stopReason: StopReason,
    error: z.string().optional(),
  }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;

/**
 * Parses one event off the wire. Anything unrecognised — an event type a
 * newer core added, or a malformed one — comes back `undefined` so the UI can
 * skip it: ignoring unknown events is what lets the core grow without
 * breaking an older UI.
 */
export function parseEvent(value: unknown): CoreEvent | undefined {
  const result = CoreEvent.safeParse(value);
  return result.success ? result.data : undefined;
}

// --- method tables ---------------------------------------------------------

/** Requests the UI sends and the core answers. */
export const uiRequests = {
  initialize: { params: InitializeParams, result: InitializeResult },
  submit: { params: SubmitParams, result: Empty },
  abort: { params: Empty, result: Empty },
  command: { params: CommandParams, result: CommandResult },
  shutdown: { params: Empty, result: Empty },
} as const;

/** Requests the core sends and the UI answers. */
export const coreRequests = {
  permission: { params: PermissionParams, result: PermissionResult },
} as const;

/** The core's only notification; its payload is one `CoreEvent`. */
export const EVENT_METHOD = "event";

type Table = Record<string, { params: z.ZodType; result: z.ZodType }>;
type Shape<T extends Table> = {
  [M in keyof T]: { params: z.infer<T[M]["params"]>; result: z.infer<T[M]["result"]> };
};

export type UiRequests = Shape<typeof uiRequests>;
export type CoreRequests = Shape<typeof coreRequests>;
