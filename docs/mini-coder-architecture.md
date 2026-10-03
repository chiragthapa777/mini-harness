# mini-coder — architecture

How the UI and core split and talk. Only what phases 1–2 need.

## Shape

One command, two processes. The UI owns the terminal and spawns the core as its child, speaking JSON-RPC over stdio. Ink is the first UI; anything that can spawn a process can replace it.

```
$ mini-coder
┌───────────────────────────┐  spawn: node mini-coder.mjs serve
│ UI process                │─────────────────────────────────┐
│ apps/coder/src/ui         │                                 ▼
│  Ink views                │  stdin  ── requests ──►  ┌────────────────────────┐
│  view state = fold(events)│                          │ core process           │
│                           │  stdout ◄── events ────  │ apps/coder/src/serve   │
│                           │         ◄── permission?  │  Session (controller)  │
│                           │         ── decision ──►  │  loop → llm, tools     │
└───────────────────────────┘                          │  stderr → log file     │
                                                       └────────────────────────┘
```

Ink uses the child process too: one transport, exercised by every run.

## Packages

| Package | Contains | May import |
|---|---|---|
| `coder-protocol` | message schemas (zod), `PROTOCOL_VERSION`, JSON-RPC `Connection` | zod |
| `coder-core` | `Session`, loop, permission gate, memory | protocol, `llm`, `core/protocol` |
| `coder-tools` | `read_file`, `edit_file`, `bash`, … | `coder-core` types |
| `apps/coder` | `main.ts`, `ui/`, `serve.ts` | `ui/`: protocol only |

A test fails if `ui/` imports `coder-core` or `coder-tools`.

## Protocol

JSON-RPC 2.0, one JSON object per line.

| Direction | Method | Params → result |
|---|---|---|
| UI → core | `initialize` | `protocolVersion, cwd, model?, mode?, resume?` → `sessionId, model` |
| UI → core | `submit` | `text` → `{}`; the turn runs in the background |
| UI → core | `abort` | → `{}` |
| UI → core | `command` | `clear`, `compact`, `undo` or `model` → `message` |
| UI → core | `shutdown` | → `{}`, then the core exits |
| core → UI | `event` (notification) | one `CoreEvent` |
| core → UI | `permission` (request) | `tool, input, reason` → `allow`, `deny` or `always` |

```ts
type CoreEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: unknown }
  | { type: "tool_output"; callId: string; chunk: string }
  | { type: "tool_end"; callId: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: "end_turn" | "aborted" | "max_iterations" | "token_budget" | "length" | "error"; error?: string };
```

Rules:

- **Plain data.** The UI folds events into view state.
- **Unknown events are ignored.** Adding is fine; renaming or removing bumps `PROTOCOL_VERSION`, and `initialize` rejects a mismatch.
- **Permission is a core → UI request.** The JSON-RPC `id` pairs question and answer; the loop awaits it. `abort` resolves it as deny. `always` allows that call for the session.
- **One turn at a time.** The UI queues input typed mid-turn.
- **`resume`** replays saved events before `initialize` replies; the UI rebuilds through the same fold.

## One turn

```
UI                         core Session                 llm / tools
│── submit{text} ────────►│
│◄── {} ──────────────────│── stream(history, signal) ──►│
│◄── event turn_start ────│◄── text deltas ──────────────│
│◄── event text_delta … ──│   parse tool_call → edit_file
│                         │── gate.check ──► ask
│◄── permission{…} ───────│   (loop waits)
│── {decision: allow} ───►│── run(input, signal) ───────►│
│◄── event tool_start ────│◄── output chunks ────────────│
│◄── event tool_output … ─│
│◄── event tool_end ──────│   append result, next iteration
│◄── event turn_end ──────│   no tool calls → done
```

## Lifecycle

**Start.** `main.ts` spawns `serve`, sends `initialize`, renders on reply. Core stderr goes to `~/.mini-coder/logs/`, never Ink's terminal.

**Stop.** Every path ends both:

1. `/quit` or Ctrl+C twice → `shutdown`. The core aborts the turn, kills bash process groups, flushes the log, exits. After 2 seconds the UI kills it.
2. UI crashes → core stdin closes → treated as `shutdown`.
3. Core crashes → the UI shows the error, exits non-zero.

**Esc** → `abort`. The turn's `AbortController` stops the LLM stream and bash; `turn_end` reports `aborted`.

## Headless

`mini-coder -p "…"` is a second UI: prints `text_delta`, denies every permission, exits on `turn_end`. `--mode` goes in `initialize`, so the gate decides what is widened.

## Inside the core

`Session` depends only on interfaces, wired in `serve.ts`:

- `ChatClient` (`packages/llm`)
- `Tool { name, schema, run(input, { signal, onOutput }) }`
- `PermissionGate.check(call) → allow | deny | ask`
- `Memory`: skills, `AGENTS.md`, facts, session log ([mini-coder-memory.md](mini-coder-memory.md))

Tests drive `Session` through a `Connection` over in-memory streams with a fake `ChatClient`: the real code path.

## Not now

- In-process transport, sockets, several sessions per process.
- State snapshots (resume replays events).
- JSON Schema and Go codegen, until a Go UI exists.
- OpenTelemetry: the session log is the trace.
