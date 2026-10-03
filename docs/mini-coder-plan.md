# mini-coder — plan

A local coding-agent CLI; the only remote call is the LLM API.
Design: [architecture](mini-coder-architecture.md), [memory](mini-coder-memory.md).

## Reuse

- `packages/llm`: providers, with cancellation and caller-supplied keys.
- `packages/core/protocol`: the `tool_call` format.

## Layout

- `apps/coder`: `main.ts`, `ui/` (Ink, headless), `serve.ts` (core process).
- `packages/coder-protocol`: the JSON-RPC contract.
- `packages/coder-core`: session, loop, permission gate, context, memory, MCP.
- `packages/coder-tools`: tools, path guard, checkpoints.
- `packages/coder-config`: layered settings.

## Settled

- File content stays in JSON tool calls.
- Overwriting needs a prior read and an unchanged mtime.
- Edits are checkpointed; `/undo` reverts the last turn, except bash changes.
- `grep` uses `rg`, else a Node fallback.
- Memory is plain files under `~/.mini-coder/`, outside the repo. `AGENTS.md` stays human-owned.
- Each turn is capped at 100 iterations and a token budget.
- macOS/Linux first.

## Phases

| # | Phase | Done when |
|---|---|---|
| 0 | `llm` cancellation, `core/protocol` export. **Done.** | — |
| 1 | `coder-protocol`: schemas, `Connection`, version check. **Done.** | messages round-trip both ways over in-memory streams |
| 2 | `coder-core` + `serve`: session, loop, stub gate; `read_file`, `edit_file`, `bash`. **Done.** | fake-model session: tool → permission → result → `turn_end`; abort works |
| 3 | Headless `-p`, process lifecycle, bundle. **Done.** | `-p` works with a real model; either side exiting ends both |
| 4 | Ink UI: fold, transcript, tool cards, permission prompt, Esc, input queue. **Done.** | interactive session works; `ui/` import boundary test passes |
| 5 | Permissions: rules, modes, bash splitting, deny list; `write_file`, `glob`, `grep` | table-driven rule tests pass |
| 6 | `coder-config`, `/model`; `AGENTS.md`, skills, `remember` | layers merge; deny wins; skills load on demand |
| 7 | Episodic memory: session log, `resume`, summaries, `recall`; compaction | resume rebuilds by replay; long session compacts |
| 8 | MCP (official SDK) | MCP tool runs after approval |
| 9 | Opt-in: OpenTelemetry, bash sandbox | off by default |

Each phase ends with typecheck and tests green.

## Decisions

- New loop in `coder-core`; the server loop is untouched.
- Distribution: esbuild single-file Node bundle (Node 22+).
