# mini-coder — plan

A single-user coding-agent CLI. The harness runs locally; the only remote call is the LLM API.
UI–core design: [mini-coder-architecture.md](mini-coder-architecture.md).

## Reuse

- `packages/llm`: providers, with cancellation and caller-supplied keys.
- `packages/core/protocol`: the `tool_call` format.

## Layout

- `apps/coder`: `main.ts`, `ui/` (Ink, headless), `serve.ts` (core process).
- `packages/coder-protocol`: the JSON-RPC contract.
- `packages/coder-core`: session, loop, permission gate, context, MCP.
- `packages/coder-tools`: tools, path guard, checkpoints.
- `packages/coder-config`: layered settings.

## Settled

- File content stays in JSON tool calls; parse errors go back to the model.
- Overwriting needs a prior read and an unchanged mtime.
- Edits are checkpointed; `/undo` reverts the last turn, except bash changes.
- `grep` uses `rg`, else a Node fallback.
- `remember()` writes `.mini-coder/MEMORY.md`, never `AGENTS.md`.
- Each turn is capped at 100 iterations and a token budget.
- macOS/Linux first.

## Phases

| # | Phase | Done when |
|---|---|---|
| 0 | `llm` cancellation, `core/protocol` export. **Done.** | — |
| 1 | `coder-protocol`: schemas, `Connection`, version check | requests, notifications and core → UI requests round-trip over in-memory streams |
| 2 | `coder-core` + `serve`: session, loop, stub gate; `read_file`, `edit_file`, `bash` | a scripted fake-model session runs tool → permission → result → `turn_end`, and aborts cleanly |
| 3 | Headless `-p`, process lifecycle, bundle | `mini-coder -p` works against a real model; quitting or crashing either side ends both |
| 4 | Ink UI: fold, transcript, tool cards, permission prompt, Esc, input queue | interactive session works; `ui/` import boundary test passes |
| 5 | Permissions: rules, modes, bash splitting, deny list; `write_file`, `glob`, `grep` | table-driven rule tests pass |
| 6 | `coder-config`, `AGENTS.md`, memory, `/model` | layers merge; deny always wins |
| 7 | Session log, `resume`, truncation, compaction | resumed session rebuilds by replay; long session compacts |
| 8 | MCP (official SDK), skills | MCP tool runs after approval |
| 9 | Opt-in: OpenTelemetry, bash sandbox | off by default |

Each phase ends with typecheck and tests green.

## Decisions

- New loop in `coder-core`; the server loop is untouched.
- Distribution: esbuild single-file Node bundle (Node 22+).
