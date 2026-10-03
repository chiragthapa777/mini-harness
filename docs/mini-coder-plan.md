# mini-coder — plan

A single-user coding-agent CLI. The harness runs locally; the only remote call is the LLM API.

## Reuse

- `packages/llm`: the provider interface. It gets an `AbortSignal`, and the caller can pass API keys. The server still reads keys from its config.
- `packages/core` protocol: the `tool_call` format, imported through a `./protocol` export.
- Not used: `config`, `mcp`, `memory`, `db`, `jobs`, `agent`, `apps/*`.

## Layout

- `apps/coder`: Ink TUI, headless `-p`, slash commands; the `mini-coder` command.
- `packages/coder-core`: loop, context builder, tool registry, permission gate, sessions, compaction, MCP, and the `ToolExecutor`/`MemoryStore`/`TraceSink` interfaces.
- `packages/coder-tools`: file tools, `glob`, `grep`, `bash`, path guard, checkpoints.
- `packages/coder-config`: layered settings (global → project → local → flags).

## Settled

- File content stays in JSON tool calls; parse errors go back to the model.
- Overwriting a file needs a prior read and an unchanged mtime.
- Every edit is checkpointed; `/undo` reverts the last turn, except changes made through bash.
- `grep` uses `rg` if installed, otherwise a Node fallback.
- `remember()` writes `.mini-coder/MEMORY.md` (gitignored), never `AGENTS.md`.
- Traces are saved as local JSONL; OpenTelemetry is opt-in.
- Each turn is capped at 100 iterations and a token budget.
- Headless mode: "ask" means deny.
- macOS/Linux first. The OS sandbox is opt-in and comes last.

## Phases

0. Cancellation in `llm`, and the `core` protocol export.
1. Loop, `read_file`/`edit_file`/`bash`, `-p`.
2. TUI.
3. Permissions, `write_file`/`glob`/`grep`.
4. Config, `AGENTS.md`, memory.
5. Compaction, sessions.
6. MCP, skills.
7. OpenTelemetry, sandbox.

Each phase ends with typecheck and tests green.

## Architecture decisions

1. Loop: written new in `coder-core`; the server's loop is untouched.
2. MCP: the official `@modelcontextprotocol/sdk` (stdio and HTTP).
3. Distribution: esbuild single-file Node bundle (Node 22+).
