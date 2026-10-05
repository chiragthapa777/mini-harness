# mini-coder — architecture

A coding agent that runs in a terminal, inside the folder it is started in. The only remote call is the LLM API. This is the design and the reasons for it; [implementation.md](implementation.md) section 3.10 lists what each file does, and [coder.md](coder.md) covers installing and releasing.

## Shape

One command, one process. The UI owns the terminal and calls the core as an object in the same program.

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

The UI and the core only exchange messages. A message is a plain object passed to a function.

## Packages

| Package | Contains | May import |
|---|---|---|
| `coder-core` | `Session`, loop, permission gate, settings, memory, session log; `store.ts`: the persistence layer; `wire.ts`: the message types | `llm`, `core/protocol` |
| `coder-tools` | `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, the path guard | `coder-core` types |
| `apps/coder` | `main.ts`, `core.ts`, `mcp.ts`, `ui/` | `ui/`: `coder-core/wire` and `ink-markdown` only |

Reused from the rest of the repo: `packages/llm` (providers, cancellation, caller-supplied keys), `packages/core/protocol` (the `tool_call` format), `packages/mcp` (the MCP client) and `packages/ink-markdown`. The server's own loop is untouched; mini-coder has its own in `coder-core`.

`core.ts` is the one file that imports `coder-core`, `coder-tools`, `llm` and `mcp` together. A test fails if `ui/` imports the rest of `coder-core`, or `coder-tools`: the UI gets its core as an argument.

## Messages

Plain objects. Every message is one-way: there are no requests, replies or ids. The types are all of `packages/coder-core/src/wire.ts`.

```ts
// UI → core: session.receive(message)
type UiMessage =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "command"; name: "clear" | "compact" | "undo" | "model"; arg?: string }
  | { type: "permission_answer"; callId: string; decision: "allow" | "deny" | "always_project" | "always_user" };

// core → UI: the send function given to the Session
type CoreMessage =
  | { type: "session"; model: string; mode: PermissionMode; tools: Listed[]; skills: Listed[] }
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: unknown }
  | { type: "tool_output"; callId: string; chunk: string }
  | { type: "tool_end"; callId: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: "end_turn" | "aborted" | "max_iterations" | "token_budget" | "length" | "error"; error?: string }
  | { type: "permission_request"; callId: string; tool: string; input: unknown }
  | { type: "notice"; text: string; isError?: boolean }
  | { type: "user"; text: string }              // only inside a replay
  | { type: "replay"; messages: CoreMessage[] }; // a resumed session's earlier turns
```

Rules:

- Plain data, not validated. Both ends are the same program, type-checked together. The UI folds the core's messages into view state.
- No handshake. `main.ts` passes the flags and the current folder to `startCore`. The core says `session` once it is up, and again when `/model` changes it.
- Delivery is a function call. `send` runs the UI's handler before it returns, so a handler must not throw and must not do slow work.
- Permission is two messages. The core sends `permission_request` and the loop waits for the `permission_answer` with the same `callId`. `abort` counts as deny.
- A command answers with a `notice`, as does a `submit` sent while a turn runs.
- One turn at a time. The UI queues input typed mid-turn. `/compact` is a turn too.

## One turn

```
UI                         core Session                 llm / tools
│── submit{text} ────────►│
│                         │── stream(history, signal) ──►│
│◄── turn_start ──────────│◄── text deltas ──────────────│
│◄── text_delta … ────────│   parse tool_call → edit_file
│                         │── checkPermission ──► ask
│◄── permission_request ──│   (loop waits)
│── permission_answer ───►│── run(input, signal) ───────►│
│◄── tool_start ──────────│◄── output chunks ────────────│
│◄── tool_output … ───────│
│◄── tool_end ────────────│   append result, next iteration
│                         │   append one line to the session log
│◄── turn_end ────────────│   no tool calls → done
```

Tool calls do not use provider-native function calling: the model writes a fenced `tool_call` block, the loop parses it, and the block is hidden from the screen. A bad call becomes an error result for the model, never an exception. Guardrails per turn: 100 model calls, 2M tokens, tool output capped at 30k characters.

## Lifecycle

Start. `main.ts` awaits `startCore({ cwd, model, mode, resume })`, which reads settings and memory, starts the MCP servers, builds the `Session` and returns `{ send, onMessage, stop }`. Messages sent before the UI registers its handler, such as the first `session`, are kept and delivered when it does.

Stop. `/quit` or Ctrl+C twice, then `main.ts` awaits `core.stop()`: it aborts the turn, kills bash process groups and shuts the MCP servers down.

Esc sends `abort`. The turn's `AbortController` stops the LLM stream and bash; `turn_end` reports `aborted`.

Headless. `mini-coder -p "…"` is a second UI over the same `startCore`: it prints `text_delta`, denies every permission prompt, and exits on `turn_end`. `--mode` widens what runs without asking.

## Why one process

An earlier version ran the core as a child process behind a JSON-RPC package. It was removed: nothing else will drive the core, and the pipe cost more to read than it bought. What the child process did, and what does it now:

- Terminal ownership. Ink draws on stdout, so nothing else may write there. Ink patches `console.*` and prints that output above its own drawing. Bash output is read through pipes. There is no log file.
- Ctrl+C. Ink reads keys in raw mode, so Ctrl+C is a key press, not a signal, and bash runs in its own process group. In `-p` a SIGINT handler stops the core and exits 130.
- Crashes. An uncaught error in the core ends the whole program. Ink restores the terminal on any exit; Node prints the error.
- A blocked event loop freezes the screen. Core code must stay asynchronous during a turn.

Given up: a UI written in another language, and a UI that survives a core crash. Getting either back means JSON lines over a child's stdin and stdout.

## Permissions

`checkPermission(mode, tool, input, rules)` answers allow, deny or ask. Every tool has a kind: `read`, `write` or `exec`. In order:

1. The block list and deny rules refuse, in every mode.
2. Reads run.
3. Mode `bypass` allows; mode `plan` denies.
4. Allow rules allow.
5. Mode `accept-edits` allows writes.
6. Otherwise writes and commands ask.

A rule is `tool`, `tool(command)` (exactly that) or `tool(command:*)` (that, or that plus arguments). A bash line is split into the commands it runs; every one needs an allow rule, and one denied command denies the line. A line with substitution, redirection or a subshell is not split, so only an exact rule covers it. Answering "always" adds an allow rule and saves it, for this project or for every project (see Settings): a file tool as a whole, a command only verbatim.

The block list is a set of patterns over the whole command: `sudo`, deleting `/` or `~`, disk devices, a download piped into a shell, and anything naming `.env*`, `~/.ssh` or mini-coder's settings. It is not a sandbox. The sandbox is: with `sandbox: true`, bash runs under macOS `sandbox-exec`, writing only inside the project, temp folders and package-manager caches. On other systems a sandboxed command refuses to run.

File tools go through the path guard: realpath, inside the project, never secrets. Overwriting needs a prior read and an unchanged file. Edits are checkpointed per turn; `/undo` reverts the last turn's file changes, not what bash did.

## Settings

Three files, most specific first: the local file `~/.mini-coder/projects/<slug>/settings.json`, the repository's `<project>/.mini-coder/settings.json`, and the user's `~/.mini-coder/settings.json`. Keys: `model`, `mode`, `permissions`, `providers`, `mcpServers`, `sandbox`. Rules add up; otherwise the first file that sets a key wins. Flags win over settings.

The repository's file comes with the clone, so it is not trusted to loosen anything. Only its `model`, its deny rules and `sandbox: true` count. Allow rules, the mode, provider keys and MCP servers come from the local and user files alone; otherwise cloning a repository could hand it a shell or an API key.

mini-coder writes only the local and user files. Both live in `~/.mini-coder`, so they are never committed and a repository cannot ship one. An "always" answer saves its rule to either; `/model` saves the model to the local file. A write changes one key and keeps the rest of the file, never overwrites a broken file, and goes through a temp file and a rename.

## Memory

Plain files, no database. Everything mini-coder writes lives outside the project, so it is never committed.

One layer does the reading and writing: `coder-core/src/store.ts`. It knows every path below and nothing about what the files mean; settings, memory and the session log get plain text and records from it. A test fails if any other core file reaches for the file system, except the `/undo` snapshots of project files.

```
~/.mini-coder/
  settings.json
  AGENTS.md                         personal rules, written by the user
  MEMORY.md                         facts about the user, all projects
  skills/<name>/SKILL.md            personal skills
  projects/<project-slug>/          slug = project realpath, "/" → "-"
    settings.json                   local settings: "always" rules, /model
    MEMORY.md                       facts about this project
    sessions/<time>-<id>.jsonl      one line per turn

<project>/
  AGENTS.md                         project rules, human-owned, committed
  .mini-coder/settings.json         repository settings, untrusted
  .mini-coder/skills/<name>/SKILL.md project skills
```

| Kind | Stored as | Gets into context |
|---|---|---|
| Procedural | `AGENTS.md`, `SKILL.md` | `AGENTS.md` in full; skills as a name and description list, the file loaded on demand |
| Semantic | `MEMORY.md`, one fact per line | in full, in the system prompt |
| Episodic | session logs | not by default; the `recall` tool searches them |

Memory is loaded once per session, so the system prompt never changes mid-session and the provider's prompt cache keeps working. The prompt order is stable-first for the same reason: rules, tool catalog, memory, environment.

- `remember(fact, scope)` appends a line; it is a write, so it asks. The fact reaches the prompt from the next session.
- `skill(name)` returns a skill's file. Typing `/<skill> args` sends the model the instruction to load and follow it; a project skill replaces a personal one of the same name.
- `recall(query)` returns up to 10 earlier turns containing every word of the query.

## Sessions

Each turn appends one line to the session log: the messages a replay needs (the user's text, the reply text joined up, tool cards, how the turn ended) and the entries the turn added to the model's history. `/clear` and compaction write a line marked `reset`, after which the history starts over.

Resume is a replay. `--resume` reopens the folder's latest log. The core rebuilds the model's history from it and sends one `replay` message; the UI folds it like live messages, and a headless run ignores it. There are no state snapshots.

Compaction replaces the history with the model's own summary of it: before a turn that starts above 120k tokens of context, or on `/compact`. The log keeps every turn, so recall sees the whole session while the model continues from the summary.

## MCP

Servers under `mcpServers` in the user's settings are started with `packages/mcp` (stdio only) and their tools offered as `server__tool`. What such a tool does is unknown, so each is an `exec` tool: it asks first, and an allow rule naming it skips the prompt. A server that does not start is reported and skipped.

## The interactive UI

View state is `fold(state, message)`, pure and tested without a terminal. The model's thinking is shown dim, above its reply. Finished items are printed once and left to the terminal's scrollback; only the last one redraws.

Typing `/` opens a menu of actions and skills under the input, filtered by prefix. `/tools` lists what the model can use. A permission prompt shows the command or the edit in full and ignores keys for its first 600 ms, so typing ahead cannot approve a call.

## Testing

Tests call `Session.receive` and collect what it sends, with a fake `ChatClient`: the real code path, no streams. `apps/coder` tests run `-p` as a real process against a local fake of OpenRouter and a fake MCP server. The Ink view itself has no automated test.

## Known limits

- The sandbox is macOS only, and only bash is confined; MCP servers are not.
- No compaction in the middle of a turn: one very long turn can overflow the context.
- `MEMORY.md` only grows; there is no cap or cleanup.
- `--resume` always takes the latest session; a turn the process dies in is not logged.
- `glob` and `grep` are plain Node and do not read `.gitignore`.
- `plan` mode denies every MCP tool, read-only ones included.
- No OpenTelemetry: the session log is the trace.
