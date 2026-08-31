export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  message_count: number;
  last_message_at: string | null;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
}

export interface TraceStep {
  iteration: number;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface Trace {
  provider: string;
  model: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason: string;
  error?: string;
  steps: TraceStep[];
}

/** Mirrors RunEvent in @mini-agent/core, plus the two transport events. */
export type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "run_start"; provider: string; model: string }
  | { type: "iteration_start"; iteration: number }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "iteration_end"; iteration: number; inputTokens: number; outputTokens: number }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "guardrail"; reason: string }
  | { type: "reply"; text: string }
  | { type: "trace"; trace: Trace }
  | { type: "error"; message: string }
  | { type: "done" };

/** What the UI renders for one assistant turn. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  steps?: { iteration: number; calls: ToolCallView[] }[];
  trace?: Trace;
  error?: string;
  streaming?: boolean;
}

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}
