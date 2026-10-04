/**
 * Everything the UI and the core say to each other. They run in one process,
 * so a message is a plain object passed to a function. Every message is
 * one-way: nothing is a reply, so there are no ids to match.
 */

export const PERMISSION_MODES = ["default", "accept-edits", "plan", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const COMMANDS = ["clear", "compact", "undo", "model"] as const;
export type Command = (typeof COMMANDS)[number];

export type Decision = "allow" | "deny" | "always";
export type StopReason = "end_turn" | "aborted" | "max_iterations" | "token_budget" | "length" | "error";

/** A tool or a skill, as the UI lists it. */
export interface Listed {
  name: string;
  description: string;
}

export type UiMessage =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "command"; name: Command; arg?: string }
  | { type: "permission_answer"; callId: string; decision: Decision };

export type CoreMessage =
  | { type: "session"; model: string; mode: PermissionMode; tools: Listed[]; skills: Listed[] } // at start, and when the model changes
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: unknown }
  | { type: "tool_output"; callId: string; chunk: string }
  | { type: "tool_end"; callId: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: StopReason; error?: string }
  | { type: "permission_request"; callId: string; tool: string; input: unknown; reason: string }
  | { type: "notice"; text: string; isError?: boolean } // a command's result, or why a message was refused
  | { type: "user"; text: string } // what the user sent; the core sends it only inside a replay
  | { type: "replay"; messages: CoreMessage[] }; // a resumed session's earlier turns, to rebuild the screen

/** The core as a UI sees it: reachable only through messages. */
export interface Core {
  send(message: UiMessage): void;
  /** Sets the one handler for the core's messages; those sent before it was set arrive first. */
  onMessage(handler: (message: CoreMessage) => void): void;
  /** Aborts the running turn, waits for it to end, and shuts down what the core started. */
  stop(): Promise<void>;
}
