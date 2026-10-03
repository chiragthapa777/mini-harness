# mini-coder — plan

A single-user coding agent CLI, in the spirit of Claude Code and Codex. The harness runs
on the user's machine; by default the only remote call is the LLM API.

This is the plan, not a record of what is built. When a phase lands, its shipped shape
goes into [`implementation.md`](implementation.md), and [`architecture.md`](architecture.md)
gains the local-harness gateway.

---

## 1. What carries over from mini-harness

mini-coder runs on a laptop with no Postgres, no API server and no worker. That rules out
most of the server stack, but the harness's lower layers were written provider- and
storage-agnostic and come across nearly unchanged.

| Package / app | Verdict | Why |
|---|---|---|
| `packages/llm` | **Reuse**, with one small addition | `ChatClient` (`invoke`/`stream`), all four providers, lazy SDK loading, reasoning deltas. Needs an `AbortSignal` option so Esc can cancel a stream (§4, phase 0). |
| `packages/core` — `protocol.ts` | **Reuse as is** | `renderToolCatalog`, `parseToolCalls`, `ToolCallTextFilter`, `renderToolResults` *are* the tool-call wire format. mini-coder must speak the same one (CLAUDE.md). |
| `packages/core` — `types.ts` | **Reuse in part** | `AgentTool`, `StopReason`, `TraceStep`, `Trace`. `WorkingMemory` is server-shaped (semantic/episodic slots) and is not used. |
| `packages/core` — `loop.ts` / `stream.ts` | **Pattern only, not reused** | Right shape, wrong capabilities: no abort, no permission gate, no way to pause for a user answer, history is internal and not returned, no compaction, iteration cap tuned for chat (8). `truncated()` is reused. A new loop is written for mini-coder; moving the server onto it is a later, separate decision. |
| `packages/core` — `tools.ts` | **Optional reuse** | `web_search` / `scrape_url` / `fetch_url` work locally, but they are extra remote calls. Off by default; opt-in tools behind `ask`. `current_time`/`calculator` are not needed. |
| `packages/core` — `config.ts` | **Not reused** | Server system prompt and env-driven run config. mini-coder has its own prompt and file-based settings. |
| `packages/config` | **Reuse, narrowly** | Still the one reader of `process.env`, and `packages/llm` reads provider keys from it. mini-coder's own settings are files (§3.3), loaded by a new loader. The zod-with-fallback helpers are the pattern to copy. |
| `packages/mcp` | **Reuse** | `McpClient` (stdio JSON-RPC), `jsonSchemaToZod`, and `mcpTools(servers)` already take the server map as an argument. Two changes: names become `mcp__server__tool` (today `server__tool`), and `console.warn` (server stderr, startup failures) must go through an injectable logger, or it tears up the Ink screen. |
| `packages/search` | **Optional**, through the web tools above | `guardedFetch` is only needed if web tools are enabled. |
| `packages/memory` | **Not reused** | Every store is Postgres/pgvector. `procedural.ts` loads whole skill files, but mini-coder wants an index plus on-demand reads. `summarizer.ts`'s `complete()` is a pattern for the compaction call, nothing more. |
| `packages/db`, `packages/jobs`, `packages/agent` | **Not reused** | Postgres, the job queue, and server run orchestration. |
| `apps/api`, `apps/worker`, `apps/web` | **Not reused** | Server-side surfaces. |
| `apps/tui` — `markdown-parser.ts`, `Markdown.tsx` | **Reuse**, moved to a package | Two apps will use them, so they move to `packages/tui-kit` (repo rule: shared code lives in `packages/`). |
| `apps/tui` — `build.ts` | **Reuse the pattern** | esbuild single-file bundle → installable `mini-coder` command. |
| `apps/tui` — `api.ts`, `token.ts`, `Login.tsx`, `Chat.tsx` | **Not reused** | Server client, JWT, login. mini-coder has no server to log in to. |
| Test setup (`tsx --test`) | **Reuse** | Same runner, same layout (`test/*.test.ts`). |

Net new code lives in two packages and one app (§2).

---

## 2. Layout

```
apps/
  coder/                  the `mini-coder` CLI: Ink TUI, headless -p, slash commands
packages/
  coder-core/             the local harness: loop, context builder, tool registry,
                          permission gate, settings, sessions, compaction, interfaces
  coder-tools/            read_file, edit_file, write_file, glob, grep, bash,
                          path guard, checkpoints (also closes TODO 17 for the server later)
  tui-kit/                Markdown renderer moved out of apps/tui, shared Ink pieces
  llm/                    + AbortSignal on invoke/stream
  core/                   + `./protocol` subpath export, so coder-core does not pull in
                          the web tools (and cheerio) just to parse a tool_call block
  mcp/                    + mcp__ prefix option, injectable logger
```

Dependency direction: `apps/coder → coder-core, coder-tools, tui-kit`;
`coder-tools → coder-core` (for interfaces only); `coder-core → core/protocol, llm, mcp`.
Nothing in mini-coder imports `db`, `memory`, `jobs` or `agent`.

---

## 3. Design

### 3.1 Interfaces (`coder-core`)

```ts
interface ToolExecutor {           // runs one already-approved call
  run(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
interface MemoryStore {            // sessions + remember()
  append(sessionId: string, entry: SessionEntry): Promise<void>;
  load(sessionId: string): Promise<SessionEntry[]>;
  remember(fact: string): Promise<void>;
}
interface TraceSink {              // fire-and-forget, never blocks the loop
  record(event: TraceEvent): void;
  flush(): Promise<void>;
}
```

Defaults: local executor; JSONL memory store under `~/.mini-coder/sessions/`; JSONL trace
sink on disk. The OpenTelemetry sink is opt-in (§5, decision 4).

### 3.2 Loop and events

The loop calls the model with the system prompt (tool schemas included via
`renderToolCatalog`) and the history. It then runs the parsed tool calls, appends the
results (errors included), and repeats until a reply contains no tool calls.

The repo requires guardrails on every loop, so this one has them too:
- an iteration cap per user turn (default 100)
- a token budget per user turn
- Esc to abort

The core is UI-agnostic. It emits events and the TUI renders them:

| Event | Payload |
|---|---|
| `text_delta` / `thinking_delta` | streamed prose, tool-call fences already filtered out |
| `tool_start` / `tool_end` | id, name, input / output, isError, duration |
| `permission_request` | id, tool, input, matched rule, and `respond(decision)` |
| `compaction` | before/after token counts |
| `done` | stop reason, usage for the turn |
| `error` | message |

Abort: an `AbortSignal` goes into the model stream and into any running bash process
group. The partial assistant text is kept and marked `[interrupted]`.

Several tool calls in one reply: reads run in parallel, while writes and bash run in
order. Each call passes through the permission gate one at a time.

### 3.3 System prompt and settings

The prompt is ordered stable-first, so provider prefix caching can reuse it:
1. core rules
2. tool schemas
3. skill index
4. `AGENTS.md`
5. environment: cwd, OS, date, and git status

The environment section is snapshotted **once per session**; refreshing it every turn
would break the cache. The prompt text is a versioned file in `coder-core`, not inlined.

Settings, from most general to most specific:
1. `~/.mini-coder/settings.json`
2. `./.mini-coder/settings.json`
3. `./.mini-coder/settings.local.json`
4. CLI flags

Scalar values: the more specific layer wins. Lists: merged across layers. `deny` rules
always win. Same layering for `skills/` and `mcp.json`. On first run in a project, write
`.mini-coder/.gitignore` containing `settings.local.json`; the project's own `.gitignore`
is never edited.

### 3.4 Tools (`coder-tools`)

| Tool | Behaviour |
|---|---|
| `read_file(path, offset?, limit?)` | Numbered lines, records mtime in the session's read-set. Default limit ~2000 lines; long lines truncated. |
| `edit_file(path, old_string, new_string, replace_all?)` | Fails unless: the file was read this session, its mtime is unchanged since, and `old_string` matches exactly once (or `replace_all`). Checkpoints the file first. |
| `write_file(path, content)` | New file: allowed. Existing file: same read + mtime rule as edit. Checkpoints first. |
| `glob(pattern)` | gitignore-aware, sorted by mtime, capped. |
| `grep(pattern, path?, glob?, mode?)` | ripgrep. `mode`: files / content / count. Capped. |
| `bash(command, timeout?)` | Own process group (`detached`), whole group killed on timeout or abort. Output truncated. Persistent cwd: tracked by the harness (a `pwd` sentinel after each command), clamped to the project. |

Path guard for every file tool:
- `realpath` the path; it must resolve inside the project root
- deny `.env*`, `~/.ssh`, and the harness's own config and checkpoints

Checkpoints: a copy of each file's pre-edit content, keyed by user turn. `/undo` restores
the last turn's files. Changes made through `bash` are **not** undoable; the `/undo`
output says so.

### 3.5 Permissions

Every tool call goes through one check in the dispatcher, before the executor runs. If
several rules match, the strictest wins: deny > ask > allow. If no rule matches, the
default is allow for reads and ask for writes and bash.

Rules look like `Bash(npm test:*)`, `Edit(src/**)` or `mcp__github__*`.

Bash commands are parsed, not regex-matched:
- Split on `&&`, `||`, `;`, `|` and newlines. Every part must pass on its own.
- `$(…)`, backticks, `eval`, `bash -c`/`sh -c`, `xargs`, `find -exec` and `sudo` → ask.
- A redirection (`>`, `>>`, `tee`) to a path outside the project → ask.

The deny list is enforced on file tools, and on bash on a best-effort basis: without an OS
sandbox, `cat .env` disguised well enough can slip through. That limit is stated, not
hidden.

Modes:

| Mode | Behaviour |
|---|---|
| `default` | as above |
| `accept-edits` | file edits allowed; bash still asks |
| `plan` | read-only tools only |
| `bypass` | everything allowed except `deny` |

Headless `-p`: nobody is there to answer, so `ask` becomes deny with a message to the
model, unless `--mode` or `--allow` widen it.

OS sandbox for bash: bubblewrap on Linux, `sandbox-exec` on macOS. Writes are limited to
the project, and network is limited to an allowlist through a local proxy. It is opt-in
and comes in the last phase, because it is per-platform work and the permission gate
already covers the common case.

### 3.6 MCP and skills

- MCP: `./.mini-coder/mcp.json` and the global one are merged, then loaded through
  `packages/mcp`. Tools are named `mcp__server__tool` and default to `ask`.
- Skills: `skills/<name>/SKILL.md` with `name` + `description` frontmatter. Only the
  index goes into the prompt. The model reads the full file with `read_file`, which is
  allowed for skill directories even though they sit outside the project.

### 3.7 Context and memory

- Every tool result is truncated to ~30k chars, keeping head + tail with a marker.
- Old tool results are cleared to `[cleared: <tool> <args>]`, outside the last N turns.
  This is done in batches, not every turn, so the cache isn't broken every turn.
- Compaction at 80% of the model's context window. Token count = the provider-reported
  input tokens of the last call, so no tokenizer is needed. Context window size: from
  settings, or looked up once from OpenRouter's model list.
  - The summary has a fixed structure: goal, decisions, files touched, open tasks, and
    errors seen. It is followed by the last few turns verbatim.
  - `/compact` triggers it by hand.
- Sessions: one JSONL file per session, an append-only log of every message, tool call
  and compaction. `--resume` / `/resume` reloads one.
- `remember(fact)` appends to `./.mini-coder/MEMORY.md`, loaded alongside `AGENTS.md`
  (§5, decision 3).

---

## 4. Build order

Each phase ends usable and tested; nothing waits on a later phase to work.

| # | Phase | Delivers | Done when |
|---|---|---|---|
| 0 | Prep | `AbortSignal` in `packages/llm`. `./protocol` export from `core`. `tui-kit` extracted, with `apps/tui` switched to it. `mcp` prefix + logger options. | `pnpm typecheck && pnpm test` green; the server and `apps/tui` behave the same. |
| 1 | Loop + 3 tools | `coder-core` loop and events; `read_file`, `edit_file`, `bash`; path guard; checkpoints; headless `-p`. Stub gate: reads allow, everything else asks on stdin. | `mini-coder -p "add a test for X"` reads, edits, runs the test, and stops. Loop and tools are unit-tested with a fake `ChatClient`. |
| 2 | TUI | Ink app: streaming text, tool lines, diff on edit, permission prompt (y / n / always), Esc abort, `/clear` `/undo` `/model`. Bundled `mini-coder` bin. | An interactive session edits a file, Esc stops a runaway bash command, `/undo` reverts. |
| 3 | Permissions | Rule parser, bash splitter, the four modes, deny list, headless policy. Remaining tools: `write_file`, `glob`, `grep`. | Table-driven tests over the rules and bash parsing (including `$()`, redirections, `sh -c`). |
| 4 | Config | Layered settings, `AGENTS.md`, `.mini-coder/.gitignore`, `remember()`, env block in the prompt. | Global + project + local + flags merge as specified; deny in any layer wins. |
| 5 | Context | Truncation, tool-result clearing, auto-compaction + `/compact`, JSONL sessions + resume. | A long session compacts and carries on; `--resume` restores it. |
| 6 | MCP + skills | `mcp.json` loading, `mcp__` tools behind `ask`, skill index + on-demand load. | An MCP server's tool runs after approval; a skill is listed and then read only when needed. |
| 7 | Ops + sandbox (opt-in) | OTel `TraceSink`; bash sandbox (Linux bwrap, macOS seatbelt) with network allowlist. | Off by default; when on, a write outside the project fails at the OS level. |

---

## 5. Decisions needed before phase 1

1. **Writing file content inside the tool-call format.** `edit_file` and `write_file` put
   whole code blocks inside JSON, so every quote and newline has to be escaped. Weaker
   models get this wrong. Options:
   - **a.** Keep pure JSON; parse errors go back to the model to retry. No protocol change.
   - **b.** Allow raw content after the JSON header inside the same `tool_call` fence. Same
     fence and parser, one extension.

   Recommendation: start with a, measure the failure rate in phase 1, and move to b if it
   hurts. b changes the protocol CLAUDE.md fixes, so it needs your sign-off.
2. **ripgrep.** Either require `rg` on PATH (fast, but one more thing to install), or ship
   `@vscode/ripgrep` (downloads a per-platform binary, which complicates the
   single-file bundle). Recommendation: use `rg` if present, with a slower pure-Node
   fallback so the tool never disappears.
3. **Where `remember()` writes.** Your spec says `AGENTS.md`. That file is usually
   committed and shared with a team (this repo's is), so agent-written notes would end
   up in commits. Recommendation: write to `.mini-coder/MEMORY.md`, load it right after
   `AGENTS.md`, and gitignore it; `AGENTS.md` stays human-owned. Either way, writing it
   goes through the permission gate like any other write.
4. **OpenTelemetry vs "only remote call is the LLM".** Shipping traces is a second remote
   call. Recommendation: the default `TraceSink` writes local JSONL; the OTel exporter is
   opt-in in settings. Its dependency comes in only in phase 7.
5. **Default coding model.** `z-ai/glm-5.3-flash` is the chat default. Coding usually
   needs a stronger model; mini-coder gets its own `model` setting, and this picks its
   default.
6. **Platforms.** Process groups, and the sandbox work, are POSIX. Recommendation:
   macOS + Linux first; Windows (WSL works) later.
