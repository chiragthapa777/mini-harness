import type { CoreMessage } from "@mini-agent/coder-core/wire";

/**
 * View state is a fold over what happened: the core's messages, plus the
 * `user` message the UI adds itself when it sends one. Pure, so the
 * transcript can be tested without a terminal.
 */

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; callId: string; name: string; input: unknown; output: string; status: "running" | "done" | "error" }
  | { kind: "notice"; text: string; isError: boolean };

export interface ViewState {
  /** Append-only; while a turn runs, only the last item changes. */
  items: Item[];
  running: boolean;
  thinking: boolean;
  /** Model and mode, once the core has said them. */
  session?: { model: string; mode: string };
  /** Tokens of the latest model call. */
  usage?: { inputTokens: number; outputTokens: number };
}

export type Action = CoreMessage;

export const initialState: ViewState = { items: [], running: false, thinking: false };

const STOP_NOTICES = {
  aborted: "interrupted",
  max_iterations: "stopped: too many model calls in one turn",
  token_budget: "stopped: the turn's token budget ran out",
  length: "stopped: the reply hit the output limit",
} as const;

export function fold(state: ViewState, action: Action): ViewState {
  const add = (item: Item): ViewState => ({ ...state, thinking: false, items: [...state.items, item] });
  const last = state.items.at(-1);

  switch (action.type) {
    case "user":
      // Running from the moment it is sent, so queued input waits for turn_end.
      return { ...add({ kind: "user", text: action.text }), running: true };

    case "notice":
      return add({ kind: "notice", text: action.text, isError: action.isError ?? false });

    case "session":
      return { ...state, session: { model: action.model, mode: action.mode } };

    case "replay":
      // A resumed session: the earlier turns, none of them still running.
      return { ...action.messages.reduce(fold, state), running: false, thinking: false };

    case "permission_request":
      return state; // shown by App as a prompt, not in the transcript

    case "turn_start":
      return { ...state, running: true };

    case "thinking_delta":
      return { ...state, thinking: true };

    case "text_delta":
      if (last?.kind !== "assistant") return add({ kind: "assistant", text: action.text });
      return {
        ...state,
        thinking: false,
        items: [...state.items.slice(0, -1), { ...last, text: last.text + action.text }],
      };

    case "tool_start":
      return add({
        kind: "tool",
        callId: action.callId,
        name: action.name,
        input: action.input,
        output: "",
        status: "running",
      });

    case "tool_output":
    case "tool_end":
      return {
        ...state,
        items: state.items.map((item) => {
          if (item.kind !== "tool" || item.callId !== action.callId) return item;
          if (action.type === "tool_output") return { ...item, output: item.output + action.chunk };
          return { ...item, output: action.output, status: action.isError ? "error" : "done" };
        }),
      };

    case "usage":
      return { ...state, usage: { inputTokens: action.inputTokens, outputTokens: action.outputTokens } };

    case "turn_end": {
      const ended = { ...state, running: false, thinking: false };
      if (action.stopReason === "end_turn") return ended;
      const notice: Item =
        action.stopReason === "error"
          ? { kind: "notice", text: `error: ${action.error ?? "the turn failed"}`, isError: true }
          : { kind: "notice", text: STOP_NOTICES[action.stopReason], isError: false };
      return { ...ended, items: [...state.items, notice] };
    }
  }
}
