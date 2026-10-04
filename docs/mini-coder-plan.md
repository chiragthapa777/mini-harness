# mini-coder — plan

A local coding-agent CLI; the only remote call is the LLM API.
Design: [architecture](mini-coder-architecture.md), [memory](mini-coder-memory.md).

## Reuse

- `packages/llm`: providers, with cancellation and caller-supplied keys.
- `packages/core/protocol`: the `tool_call` format.

## Layout

- `apps/coder`: `main.ts`, `ui/` (Ink, headless), `core.ts` (builds the session). One process.
- `packages/coder-core`: session, loop, permission gate, settings, memory; `wire.ts` holds the UI ↔ core messages.
- `packages/mcp`: the MCP client, shared with the server; `apps/coder/src/mcp.ts` turns its tools into coder tools.
- `packages/coder-tools`: tools, path guard, checkpoints.

## Settled

- File content stays in JSON tool calls.
- Overwriting needs a prior read and an unchanged mtime.
- Edits are checkpointed; `/undo` reverts the last turn, except bash changes.
- `grep` is plain Node for now; `rg` is the upgrade when a large repo needs it.
- Memory is plain files under `~/.mini-coder/`, outside the repo. `AGENTS.md` stays human-owned.
- Each turn is capped at 100 iterations and a token budget.
- macOS/Linux first.

## Phases

| # | Phase | Done when |
|---|---|---|
| 0 | `llm` cancellation, `core/protocol` export. **Done.** | — |
| 1 | The UI ↔ core messages. **Done**, then simplified: the JSON-RPC package was replaced by plain one-way JSON lines in `coder-core/src/wire.ts`. | messages survive being split across chunks |
| 2 | `coder-core` + `serve`: session, loop, stub gate; `read_file`, `edit_file`, `bash`. **Done.** | fake-model session: tool → permission → result → `turn_end`; abort works |
| 3 | Headless `-p`, process lifecycle, bundle. **Done.** | `-p` works with a real model; either side exiting ends both |
| 4 | Ink UI: fold, transcript, tool cards, permission prompt, Esc, input queue. **Done.** | interactive session works; `ui/` import boundary test passes |
| 4b | Single process: `core.ts` replaces `serve.ts` and `ui/core-process.ts`; `wire.ts` keeps only the types. **Done.** | `-p` and the Ink session run with no child process |
| 5 | Permissions: rules, modes, bash splitting, deny list; `write_file`, `glob`, `grep`. **Done.** | table-driven rule tests pass |
| 6 | Settings, `/model`; `AGENTS.md`, skills, `remember`. **Done.** Settings are one file in `coder-core`, not a `coder-config` package. | layers merge; deny wins; skills load on demand |
| 7 | Episodic memory: session log, `--resume`, `recall`; compaction. **Done.** No session index or per-session summary: `recall` reads the logs. | resume rebuilds by replay; long session compacts |
| 8 | MCP. **Done**, with the repo's own `packages/mcp` client, not the official SDK. | MCP tool runs after approval |
| 8b | `/` menu: actions and skills with completion; `/tools`; `/<skill>` runs a skill. **Done.** | menu filters by prefix; a skill message reaches the model as an instruction |
| 9 | Opt-in: OpenTelemetry, bash sandbox | off by default |

Each phase ends with typecheck and tests green.

## Decisions

- New loop in `coder-core`; the server loop is untouched.
- One process. The UI ↔ core split stays as message types and an import boundary, not as a process boundary: nothing else will drive the core, and the pipe cost more to read than it bought.
- A project's settings file is not trusted: it can pick the model and add deny rules, nothing else. Allow rules, the mode and provider keys come only from `~/.mini-coder/settings.json`.
- Distribution: esbuild single-file Node bundle (Node 22+).
