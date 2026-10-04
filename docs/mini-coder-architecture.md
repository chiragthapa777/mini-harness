# mini-coder — architecture

How the UI and the core split and talk. Only what phases 1–4 need.

## Shape

One command, one process. The UI owns the terminal and calls the core as an object in the same program. There is no child process, no pipe and no JSON on the way.

```
$ mini-coder
┌──────────────────────────────────────────────────────────────────┐
│ mini-coder process                                               │
│                                                                  │
│  UI: apps/coder/src/ui          core: packages/coder-core        │
│  ┌─────────────────────┐        ┌──────────────────────────┐     │
│  │ Ink views, or -p    │ ─────► │ session.receive(message) │     │
│  │ state = fold(...)   │ ◄───── │ send(message)            │     │
│  └─────────────────────┘        │ loop → llm, tools        │     │
│                                 └──────────────────────────┘     │
│  apps/coder/src/core.ts builds the Session and hands it to a UI  │
└──────────────────────────────────────────────────────────────────┘
```

The UI and the core still only exchange messages. A message is a plain object passed to a function, not a line on a pipe.

## Packages

| Package | Contains | May import |
|---|---|---|
| `coder-core` | `Session`, loop, permission gate, memory; `wire.ts`: the message types | `llm`, `core/protocol` |
| `coder-tools` | `read_file`, `edit_file`, `bash`, … | `coder-core` types |
| `apps/coder` | `main.ts`, `core.ts`, `mcp.ts`, `ui/` | `ui/`: `coder-core/wire` and `ink-markdown` only |

`core.ts` is the one file that imports `coder-core`, `coder-tools` and `llm` together. A test fails if `ui/` imports the rest of `coder-core`, or `coder-tools`: the UI gets its core as an argument.

## Messages

Plain objects. Every message is one-way: there are no requests, replies or ids. The types are all of `packages/coder-core/src/wire.ts`.

```ts
// UI → core: session.receive(message)
type UiMessage =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "command"; name: "clear" | "compact" | "undo" | "model"; arg?: string }
  | { type: "permission_answer"; callId: string; decision: "allow" | "deny" | "always" };

// core → UI: the send function given to the Session
type CoreMessage =
  | { type: "session"; model: string; mode: PermissionMode }
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: unknown }
  | { type: "tool_output"; callId: string; chunk: string }
  | { type: "tool_end"; callId: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: "end_turn" | "aborted" | "max_iterations" | "token_budget" | "length" | "error"; error?: string }
  | { type: "permission_request"; callId: string; tool: string; input: unknown; reason: string }
  | { type: "notice"; text: string; isError?: boolean }
  | { type: "user"; text: string }              // only inside a replay
  | { type: "replay"; messages: CoreMessage[] }; // a resumed session's earlier turns
```

Rules:

- **Plain data, not validated.** Both ends are the same program, type-checked together. The UI folds the core's messages into view state.
- **No handshake.** `main.ts` checks the model and mode and passes them, with the current folder, to `startCore`. The core says `session` once it is up, and again when `/model` changes it.
- **Delivery is a function call.** `send` runs the UI's handler before it returns, so a handler must not throw and must not do slow work.
- **Permission is two messages.** The core sends `permission_request` and the loop waits for the `permission_answer` with the same `callId`. `abort` counts as deny. `always` allows that call for the session.
- **A command answers with a `notice`**, as does a `submit` sent while a turn runs.
- **One turn at a time.** The UI queues input typed mid-turn. `/compact` is a turn too.
- **Resume is a replay.** `--resume` reopens the folder's latest session log. The core loads the model's history from it and sends one `replay` with what the screen showed; the UI folds it like live messages. A headless run ignores it.

## One turn

```
UI                         core Session                 llm / tools
│── submit{text} ────────►│
│                         │── stream(history, signal) ──►│
│◄── turn_start ──────────│◄── text deltas ──────────────│
│◄── text_delta … ────────│   parse tool_call → edit_file
│                         │── gate.check ──► ask
│◄── permission_request ──│   (loop waits)
│── permission_answer ───►│── run(input, signal) ───────►│
│◄── tool_start ──────────│◄── output chunks ────────────│
│◄── tool_output … ───────│
│◄── tool_end ────────────│   append result, next iteration
│◄── turn_end ────────────│   no tool calls → done
```

## Lifecycle

**Start.** `main.ts` awaits `startCore({ cwd, model, mode, resume })`, which starts the MCP servers, builds the `Session` and returns `{ send, onMessage, stop }`. Messages sent before the UI registers its handler, such as the first `session`, are kept and delivered when it does.

**Stop.** `/quit` or Ctrl+C twice → `await core.stop()`, which aborts the turn, kills bash process groups and shuts the MCP servers down, then the process exits. There is nothing to kill and no grace timer.

**Esc** → `abort`. The turn's `AbortController` stops the LLM stream and bash; `turn_end` reports `aborted`.

## What one process changes

An earlier version ran the core as a child process. What that did, and what does it now:

- Terminal ownership. Ink draws on stdout, so nothing else may write there. Ink patches `console.*` and prints that output above its own drawing. Bash output never reaches the terminal: the tool reads it through pipes. There is no log file.
- Ctrl+C. Ink reads keys in raw mode, so Ctrl+C is a key press, not a signal, and bash runs in its own process group. In `-p` a SIGINT handler calls `core.stop()` and exits 130.
- Crashes. An uncaught error in the core ends the whole program. Ink restores the terminal on any exit; Node prints the error.
- A blocked event loop freezes the screen. Core code must stay asynchronous: no sync file reads or long loops in a turn.

What is given up: a UI written in another language, and a UI that survives a core crash. Getting either back means putting the pipe back, which is JSON lines over the child's stdin and stdout.

## Headless

`mini-coder -p "…"` is a second UI over the same `startCore`: prints `text_delta`, denies every permission, exits on `turn_end`. `--mode` goes to `startCore`, so the gate decides what is widened.

## Inside the core

`Session` depends only on interfaces, wired in `core.ts`:

- `ChatClient` (`packages/llm`)
- `Tool { name, schema, run(input, { signal, onOutput }) }`
- `checkPermission(mode, tool, input, rules) → allow | deny | ask`
- Memory: `AGENTS.md`, facts and the skill list as prompt text, plus the `skill` and `remember` tools ([mini-coder-memory.md](mini-coder-memory.md))
- Settings: `loadSettings(home, root)`, read by `core.ts` and passed in as plain options

Tests call `Session.receive` and collect what it sends, with a fake `ChatClient`: the real code path, no streams.

## Not now

- A separate core process, sockets, several sessions per process.
- State snapshots (resume replays the log). Picking which session to resume: it is always the latest.
- JSON Schema and Go codegen, until a Go UI exists.
- OpenTelemetry: the session log is the trace.
