# Implementation

`docs/architecture.md` is the plan — three layers, the loop, the memory model, LLM Ops.
This is the other half: what actually exists in the repo today, file by file, so anyone
picking up the project can tell shipped from planned without reading every source file.

For the punch list of what's *not* built yet, see [`TODO.md`](../TODO.md) — the open
items there are gaps found by comparing this doc against `docs/architecture.md`. For how one
run actually works step by step (the loop, tool calls, working memory), see
[`docs/agent-run.md`](agent-run.md).

---

## 1. Status snapshot

| Layer (from architecture.md) | State |
|---|---|
| Gateway — web app | Built (`apps/web`), admin dashboard incl. job monitoring |
| Gateway — TUI | Built (`apps/tui`, Ink) |
| Gateway — WhatsApp/Telegram bot | Not built (TODO 18) |
| Agentic loop, tool protocol, guardrails | Built (`packages/core`) |
| Procedural / semantic / episodic memory | Built (`packages/memory`) |
| Memory consolidation (episodic → semantic) | Built — `extractFacts` + `consolidate_user` job on a schedule |
| LLM Ops — trace | Built (per-run trace, admin Traces tab) |
| LLM Ops — eval / observe / diagnose / gate / release | Not built (TODO 15) |
| Background job runner (queue + worker) | Built (`packages/jobs`, `apps/worker`) |
| Cron / scheduled jobs | Built (`packages/jobs` scheduler, `scheduled_jobs`) |
| Named agent personas (per-persona system prompt/config) | Not built — one global `SYSTEM_PROMPT` today (TODO 16) |
| MCP support | Built (`packages/mcp`, stdio transport) |
| mini-coder — local coding-agent CLI | In progress — see [`mini-coder-plan.md`](mini-coder-plan.md) and §3.10 |

---

## 2. Apps

### 2.1 `apps/web` — React + Vite + Tailwind

- **Routing** (`src/App.tsx`): `/login` (public), everything else behind `RequireAuth`,
  `/admin` additionally behind `RequireAdmin`. Chat lives at `/` and `/c/:id`; response
  mode is the query param `?mode=classic`, not a separate path — streaming is the
  default with no param (`src/pages/Chat.tsx` picks `ChatClassic` vs `ChatStream` from it).
  Empty conversations show a centered greeting + composer; once a turn exists it drops
  into the normal scrollable-history-plus-bottom-composer layout.
- **Chat — two paths, one contract:**
  - `ChatClassic` (`src/pages/ChatClassic.tsx`) — `POST /chat`, waits for the full reply.
  - `ChatStream` (`src/pages/ChatStream.tsx`) — `POST /chat/stream`, consumes an SSE
    stream and renders thinking, tool calls, and text as they arrive. Text streamed
    before a tool call in a non-final iteration is not part of the reply (the backend
    only ever keeps the *last* iteration's text) — the UI keeps it anyway, collapsed
    under a per-step "Notes" panel (`src/components/Message.tsx`) instead of dropping it
    or gluing it onto the answer.
  - Both render through the shared `Message` component: markdown reply, collapsible
    "Thought process" (reasoning deltas), tool call cards (input/output, pending/done/
    failed), and a trace bar (model, iterations, tokens, latency, stop reason).
- **Auth** (`src/lib/AuthContext.tsx`): token in memory + storage, validated against
  `/auth/me` once on load. `RequireAuth`/`RequireAdmin` (`src/components/`) gate routes.
- **Admin section** (`src/pages/admin/`), one route per page rather than tabs — each has
  an address worth sharing, its own back-button entry, and its own pagination:
  `/admin/users`, `/admin/memory`, `/admin/traces`, `/admin/jobs`, `/admin/schedules`
  (`/admin` redirects to the first). `AdminLayout` holds the nav and fetches the user
  list once, since four of the five pages need it for a picker.
  - `Users` — create accounts, change role, block/unblock, clear a lockout.
  - `Memory` — any user's semantic facts, filterable by kind, with a "show merged" toggle
    that reveals archived facts and the id each was merged into, plus .txt/.md upload.
  - `Traces` — filter by user, model, error status, date range; a row expands into the
    full assembled system prompt and per-step tool calls.
  - `Jobs` — queue depth by status, filters, expandable payload/result/timings, retry on
    dead-lettered rows, polling every 5s. A row that ran the agent loop expands into the
    shared `TraceDetail`.
  - `Schedules` — every schedule, system and user, with pause/resume.
- **Table kit** (`src/components/admin/Table.tsx`) — `DataTable` (columns + rows, with
  optional expansion), `Pager`, `Toolbar`, `Badge`, `Field`, `PageHeader`. Every admin
  page is a filtered, paginated list, so alignment, density, empty and loading states,
  and the pager are decided once rather than five times. Every table is paginated
  server-side, including users and schedules, which used to fetch everything.

### 2.2 `apps/api` — Express

Structured as routes / services / middleware / utils (`src/`):

```
app.ts                        express app factory, mounts every router
index.ts                      entrypoint — bootstrap admin, listen
logger.ts                     timestamped console wrapper
middleware/auth.middleware.ts requireAuth, requireAdmin, AuthedRequest
routes/                       health, auth, admin, conversations, chat — one file each
services/                     auth, users, traces, jobs, bootstrap
utils/                        http.ts (message/clampInt/parseDate), sse.ts (SSE writer)
```

**Endpoints:**

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/health` | — | liveness |
| POST | `/auth/login` | — | email+password → JWT; 423 if locked out, 403 if blocked |
| GET | `/auth/me` | user | current user from the token |
| GET | `/admin/users` | admin | list users, paginated (`{users,total}`) |
| POST | `/admin/users` | admin | create a user |
| PATCH | `/admin/users/:id` | admin | change `role`, set `blocked`, and/or `unlock`; not own role/block |
| GET | `/admin/facts` | admin | a user's semantic facts, paginated (`includeArchived`) |
| POST | `/admin/facts/upload` | admin | chunk a text file into a user's semantic memory |
| GET | `/admin/traces` | admin | traces, filterable by user/model/error/date |
| GET | `/admin/traces/:id` | admin | one trace, full detail incl. system prompt |
| GET | `/admin/jobs` | admin | background jobs, filterable by status/type/user |
| GET | `/admin/jobs/stats` | admin | queue depth by status and type |
| GET | `/admin/jobs/:id` | admin | one job |
| POST | `/admin/jobs/:id/retry` | admin | requeue a finished job (409 if still live) |
| GET | `/admin/schedules` | admin | every schedule, paginated (`{schedules,total}`) |
| PATCH | `/admin/schedules/:id` | admin | pause/resume any schedule |
| GET | `/schedules` | user | own schedules |
| GET | `/schedules/preview` | user | next 5 firings for a cron expression |
| POST | `/schedules` | user | create one (name + prompt + cron) |
| PATCH | `/schedules/:id` | user | edit or pause (own only) |
| DELETE | `/schedules/:id` | user | delete (own only) |
| GET | `/conversations` | user | own conversations |
| POST | `/conversations` | user | create one |
| GET | `/conversations/:id/messages` | user | messages in one (own only) |
| DELETE | `/conversations/:id` | user | delete (own only) |
| POST | `/chat` | user | one run, full reply |
| POST | `/chat/stream` | user | one run, SSE |

Working memory is assembled per store: procedural loads direct, semantic is RAG top-k,
episodic is RAG over conversation summaries *plus* SQL recency over messages.
`PROMPT_VERSION` is 2 — the prompt changed shape when episodic memory moved from raw
turns to summaries, so traces from before and after are not comparable.

Running an agent turn is no longer an API concern: `run`/`runStream`/`toolsFor` live in
`packages/agent`, because the worker runs the same loop for scheduled work. Conversation
CRUD moved to `packages/memory` for the same reason.

### 2.3 `apps/worker` — the job runner

A second entrypoint onto the same harness, not a second harness. `src/index.ts` starts
the poll loop and the scheduler from `packages/jobs` and drains the current batch on SIGINT/SIGTERM;
`src/handlers.ts` is the dispatch table mapping a job type to the package function that
does the work. Today it registers `agent_run` — a full agent turn with nobody watching,
persisted exactly like a chat turn (same episodic write, same trace).

Deploy it alongside the API (`docker-compose.yml`, service `worker`) or not at all: with
`JOBS_ENABLED=false` every producer does its work inline instead of enqueueing it.

### 2.4 `apps/tui` — terminal gateway

Ink + React. Same endpoints, same JWT, no harness logic of its own — a different
surface onto one agent, not a second one. `api.ts` consumes the identical SSE-over-POST
stream the browser does; `Chat.tsx` renders tool calls as they run, markdown-rendered
text as it arrives, and a trace line at the end (thinking deltas are collected but not printed — a terminal
has no collapsible panel, and reasoning would bury the answer). The JWT is cached at
`~/.mini-agent/token`, written 0600, and validated against `/auth/me` on start so an
expired token drops to the sign-in prompt rather than failing on the first message.
Agent replies are markdown, because the web app renders them — so the TUI renders them
too rather than showing literal asterisks and fences, with `<Markdown>` from
`packages/ink-markdown` (§3.11), shared with mini-coder.

Installable: `pnpm --filter @mini-agent/tui build` bundles it (esbuild) into one
executable file, `dist/mini-agent.mjs`, which `npm i -g .` or a copy onto PATH turns
into a `mini-agent` command. A bundle rather than a package with dependencies because
the TUI imports `@mini-agent/config`, a workspace package npm cannot resolve. Installed
there is no `.env` nearby, so the server address comes from `--api` or `API_URL`.
See [`docs/tui.md`](tui.md), which also covers the standalone-binary options.

Slash commands: `/new`, `/logout`, `/quit`. Needs a real terminal — piped stdin exits
with a one-line message instead of a React stack trace.

---

## 3. Packages

### 3.1 `packages/core` — the harness

- **`loop.ts` / `stream.ts`** — the agentic loop, non-streaming and streaming twins.
  Each iteration: call the model, parse `tool_call` fences out of the reply, run the
  matching tool handlers, feed results back as the next user turn. `buildSystem` renders
  retrieved memory under five headings — *How to act*, *What is known*, *Earlier in this
  conversation* (this thread's rolling recap), *Earlier conversations* (dated recaps of
  other threads), *Recent messages elsewhere* (verbatim window from other threads). The
  episodic ones are separate because a recap of an episode and the last few turns are not
  the same kind of thing, and one heading would tell the model they were. The current
  thread's recent turns are not in the system prompt at all — they are replayed as real
  chat history (`wm.history`). Guardrails:
  `maxIterations`, `maxTokensPerRun`. Every run returns a `Trace` — provider, model, the
  **fully assembled system prompt actually sent**, iterations, token counts, latency,
  stop reason, and one `TraceStep` per iteration (tool calls, tokens, latency).
- **`protocol.ts`** — the tool-calling wire format. No provider-native function calling:
  the model emits fenced ` ```tool_call ` blocks (`{"tool": "...", "input": {...}}`),
  parsed the same way on every provider. `ToolCallTextFilter` hides fence contents from
  a live stream token-by-token. `renderToolResults` sends results back as a plain user
  turn. Also exported on its own as `@mini-agent/core/protocol` (runtime imports: zod
  only), so the mini-coder CLI gets the wire format without the server tools or
  `packages/search`.
- **`tools.ts`** — the stateless default tools: `current_time`, `calculator` (shunting-
  yard, no `eval`), `web_search`, `scrape_url`, `fetch_url` (the latter three delegate to
  `packages/search`).
- **`config.ts`** — `SYSTEM_PROMPT` (one global constant today — see TODO 16),
  `PROMPT_VERSION`, `runConfig()` reading provider/model/guardrails from
  `@mini-agent/config`.
- **`provider.ts`** — thin wrapper choosing a `ChatClient` from `packages/llm` by
  provider name.

### 3.2 `packages/llm` — chat transport

Two methods, `invoke` and `stream`, over plain `{ role, content }` messages
(`ChatClient`). `chatModel(provider, model, maxTokens, connection?)` is the only place a
provider is named — `OpenAICompatClient` (OpenRouter/OpenAI), `AnthropicClient`,
`GoogleClient`, each SDK imported lazily. Also owns embeddings (`embed`, `embedQuery`)
for the vector stores.

- **Cancellation** — both methods take `{ signal?: AbortSignal }`. It is handed to each
  SDK the way that SDK wants it (a request option for OpenAI and Anthropic,
  `config.abortSignal` for Gemini), and every stream also checks it per chunk, so no
  delta arrives after an abort. A cancelled call throws the signal's `reason` whatever
  the provider (`cancelled()` maps each SDK's own abort error to it); any other error
  passes through unchanged. The server does not pass a signal today.
- **Connection** — optional `{ apiKey?, baseUrl? }`. Unset fields fall back to
  `@mini-agent/config`, which is how the server runs; the mini-coder CLI passes its own
  settings here instead of going through the server's env config.

### 3.3 `packages/memory`

- **Procedural** (`procedural.ts`) — reads every `.md` file under `SKILLS_DIR`
  (`skills/`), no search step, loaded straight into working memory.
- **Semantic** (`semantic.ts`) — `facts` table. `searchFacts` (RAG top-k, falls back to
  most-recent when no embedding), `writeFact`, `listFacts` (admin listing, offset-paged,
  no ranking). Every read path filters `archived_at IS NULL`. `writeFact` dedups exact
  repeats inline — consolidation re-derives the same sentence from overlapping batches,
  and touching `updated_at` records "seen again" without spending a row or an embedding.
- **Document ingest** (`chunk.ts`, `ingest.ts`) — `chunkText` splits on the boundaries
  the author already wrote (paragraph, then sentence, then a hard cut for a wall of text)
  and overlaps consecutive chunks, because a fact stated across a boundary otherwise
  belongs to neither chunk. `ingestDocument` writes one fact per chunk with
  `source = file:<name>#<n>`, so a retrieved passage is traceable and re-uploading an
  edited file lands on the same rows through `writeFact`'s exact-match dedup. Embeddings
  are queued, not awaited — a 200-chunk upload would otherwise be 200 serial round-trips.
  Files arrive as text in JSON (the browser reads .txt/.md itself), which keeps multipart
  handling and temp-file lifecycles out of the server; a PDF would need a parser and can
  arrive with one.
- **Fact consolidation** (`dedupe.ts`) — near-duplicates need the vector, so they are a
  job. pgvector finds pairs under `FACT_DEDUPE_DISTANCE`, union-find turns pairs into
  clusters (transitively: A~B and B~C means all three describe one thing), and a cheap
  model writes the single sentence replacing each cluster — told to resolve contradictions
  by recency rather than keeping both halves. The oldest row survives so references hold;
  losers are archived with `superseded_by` pointing at it. Nothing is deleted: a merge has
  to be reversible and auditable. A per-user cap archives the least recently updated past
  `FACT_MAX_PER_USER`. The distance default is measured, not guessed — paraphrases land at
  0.18-0.39, unrelated facts at 0.69+.
- **Conversations** (`conversations.ts`) — the container the episodic log hangs off:
  list/create/delete, messages for one thread, title-from-first-message. Lives here, not
  in an app, because both the API and the worker need it.
- **Episodic** (`episodic.ts`) — `messages` table. Three readers, three jobs:
  `conversationHistory` returns one conversation's last `HISTORY_LIMIT` (20) user/assistant
  turns in reading order — this is the chat history the model is replayed; `recall` is the
  recency window across the user's *other* threads (it takes the current conversation as an
  exclusion, so the same turns are never sent twice in one prompt); `searchMessages` is
  turn-level RAG, reached for by the `search_memory` tool. `saveMessage` appends and queues
  the embedding.
- **Summaries** (`summaries.ts`, `summarizer.ts`, `prompts.ts`) — each conversation
  carries a rolling recap under 200 words (`conversations.summary`), driven off a
  watermark (`summary_message_id`): a job reads the messages past it, rewrites the
  summary in place, and moves it. That recap is upserted as the conversation's row in
  `events` — one per conversation, so regenerating updates rather than appends, and the
  stale vector is cleared and re-queued. Nothing new past the watermark means no model
  call, so a duplicate job is free and an idle system costs nothing. Memory's prompts
  live in `prompts.ts` with their own `MEMORY_PROMPT_VERSION`; its model is
  `SUMMARY_MODEL` (defaulting to the agent's).
- **Consolidation** (`consolidate.ts`) — the gate (only past N unconsolidated messages),
  plus `extractFacts`, the default `Summarizer`: one model call returning one fact per
  line. Line-per-fact rather than JSON because a malformed line costs one fact instead of
  the batch, and cheap models are better at it. Messages are marked consolidated only
  after their facts are written, so a half-finished pass redoes the batch rather than
  losing it. `usersNeedingConsolidation` puts the same gate in SQL so the sweep enqueues
  only work that will do something.

### 3.4 `packages/jobs` — the queue

Postgres is the queue; there is no broker. `enqueue` inserts, `claim` takes a batch with
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` so N workers take disjoint
batches, and the same rows stay put as the audit log the admin panel reads — a finished
job is a row with a terminal status, not a deleted one.

- **`types.ts`** — `JobPayloads`, one map of job type → payload shape. Producers (api,
  memory) and the consumer (worker) never import each other, so this type is the only
  thing keeping them honest. This package owns the *shape* of the work; handlers own the
  behaviour.
- **`queue.ts`** — `enqueue` (with `dedupeKey`: only one live job may hold a key, so a
  sweep can re-enqueue every tick without piling up), `claim`, `succeed`, `fail`
  (exponential backoff to `max_attempts`, then dead-letter), `reapStale` (a job still
  `running` past the stale window went down with its worker), plus the admin reads
  `listJobs` / `getJob` / `jobStats` / `retryJob`.
- **`cron.ts`** — a five-field cron parser in UTC (`*`, `n`, `a-b`, lists, steps, and the
  `@daily`-style aliases), written rather than depended on: the surface needed is "is
  this valid" and "when next", and a schedule that quietly changes meaning after a
  dependency bump is worse than one we can read. Day-of-month and day-of-week OR when
  both are restricted, as in every other cron.
- **`schedules.ts` / `scheduler.ts`** — `scheduled_jobs` holds both config-defined
  maintenance schedules (`kind = 'system'`, stable `key`, seeded on worker start —
  seeding updates name/cron but never `enabled`, so an admin's pause survives a deploy)
  and user schedules (a prompt on a cadence, fired as `agent_run`). The tick only
  enqueues: a slow job never delays the next tick, and scheduled work inherits the same
  retry policy as everything else. Two guards against pile-up — a schedule with a job
  still queued/running skips its firing, and the enqueue carries a `schedule:<id>` dedupe
  key so two schedulers still produce one job.
- **`worker.ts`** — `startWorker` (claim → run → mark, sleeping only when the queue is
  empty) and `runJob` for executing one job inline. A handler that throws is recorded on
  the job, never fatal to the worker.
- **`test/`** — `cron.test.ts` (pure); `queue.test.ts` and `scheduler.test.ts` run
  against real Postgres and skip when `DATABASE_URL` is unset. Between them: dedupe,
  exclusive claim, result capture, backoff → dead-letter → manual retry, unregistered
  types, the stale reaper, idempotent seeding, the overlap guard, and pause/resume.

### 3.5 `packages/agent` — one run, assembled and persisted

`run` / `runStream` (working memory → loop → episodic write + trace) and `toolsFor`
(default tools plus the per-user `remember` / `search_memory`). Lifted out of
`apps/api/src/services` when the worker needed the same run path for scheduled work.

### 3.6 `packages/db`

Lazy singleton `pg.Pool`, a `query()` helper, and `toVector()` for pgvector literals.
Schema (`schema.sql`, applied on first boot of an empty Postgres volume):

| Table | Purpose |
|---|---|
| `users` | auth — email, password hash, role, `blocked`, lockout state |
| `conversations` | one row per chat thread, plus its rolling summary and watermark |
| `messages` | episodic log — role, content, embedding, `consolidated_at` |
| `events` | dated events — one per conversation, holding that conversation's summary; what episodic RAG ranks |
| `facts` | semantic memory — kind, content, embedding, source, plus `archived_at`/`superseded_by` for merges |
| `traces` | one row per agent run — tokens, latency, stop reason, steps (jsonb), system prompt |
| `jobs` | background work — type, payload, status, attempts, backoff schedule, dedupe key, result |
| `scheduled_jobs` | cron schedules — system (from config, keyed) and user (prompt + cadence), with `next_run_at` and the last job fired |

### 3.7 `packages/mcp` — MCP tools, as our tools

A minimal MCP client over the stdio transport: JSON-RPC 2.0 in newline-delimited JSON
over a child process, which is three methods' worth of protocol (`initialize`,
`tools/list`, `tools/call`) for what the harness needs. Written rather than vendored —
owning it keeps the package from quietly growing into a second agent framework.

- **`client.ts`** — handshake, request/response correlation by id, per-request timeouts
  (a hung server must not hang a run), and dead-process handling that fails every pending
  request instead of leaving them waiting. A server's stderr is surfaced tagged; non-JSON
  on stdout is skipped rather than treated as a protocol error, because servers that log
  to stdout are common.
- **`schema.ts`** — JSON Schema → zod, preserving what the loop actually uses (names,
  rough types, descriptions, required-ness). Unsupported constructs degrade to `unknown`:
  a tool with a loose schema is still usable, one that throws on load is not.
- **`tools.ts`** — renders MCP tools as ordinary `AgentTool`s, namespaced `server__tool`
  since two servers may both publish a `search`. They go through the same ```tool_call
  fence, catalog, and trace as every built-in tool — there is no provider-native function
  calling here, so there is no second path for them to take. The `AgentTool` shape is
  declared structurally rather than imported from core, which would make the dependency
  circular. A server that will not start contributes no tools and does not fail the run.
- Servers come from `MCP_SERVERS` (JSON, config-only — each entry is a command line).
  `packages/agent`'s `toolsWithMcp` is what merges them into a run's tool list.

### 3.8 `packages/search`

Backend for the three web tools. `SearchProvider` interface, `DuckDuckGoProvider` the
only implementation today (keyless). `guardedFetch`/`assertPublicUrl`
(`http.ts`) refuse private/loopback addresses on every redirect hop — the guard between
model-chosen URLs and the network the harness runs in. `scrape.ts` strips boilerplate to
markdown for `scrape_url`.

### 3.9 `packages/config`

The only file allowed to touch `process.env` (`src/index.ts`). Zod-validated,
re-parsed on every `getConfig()` call (not cached at import time) so tests can stub
per-case and a long-lived server never needs a restart to pick up a changed var. See
`.env.example` for the full variable list with explanations.

### 3.10 mini-coder packages

The local coding agent. Design in [`mini-coder-architecture.md`](mini-coder-architecture.md);
none of these import `db`, `memory`, `jobs`, `agent`, `config` or `mcp`.

- **`packages/coder-core`** — the controller and the loop, no UI code.
  - `wire.ts` — everything the UI and the core say to each other, also exported as
    `@mini-agent/coder-core/wire`: the `UiMessage` and `CoreMessage` types, and `Core`
    (`send`, `onMessage`, `stop`), the core as a UI sees it. Plain objects passed to
    functions, every message one-way: no ids, no replies, no validation.
  - `session.ts` — `new Session(send, options)` takes the folder, model and mode, throws
    if they are not usable, and sends `session`. `receive(message)` handles `submit`,
    `abort`, `command` and `permission_answer`; one turn at a time. Commands: `/clear`,
    `/undo` (restores the last turn's files; the model must re-read them), `/model`,
    `/compact`. Each answers with a `notice`. `stop()` aborts the turn and waits.
  - `loop.ts` — `runLoop`: stream the reply (tool_call blocks hidden from the screen),
    run each call (bad calls become error results), add results to the history, repeat
    until a reply has no calls. Limits: 100 model calls and 2M tokens per turn; tool
    output capped at 30k chars. On abort the shown text is kept, marked interrupted.
  - `gate.ts` — `checkPermission(mode, tool, input, rules)`. In order: the block list
    and deny rules refuse in every mode, `bypass` included; reads run; `bypass` allows,
    `plan` denies; allow rules allow; `accept-edits` allows writes; otherwise writes and
    commands ask. A rule is `tool`, `tool(command)` (exactly) or `tool(command:*)` (that,
    or that plus arguments), parsed by `parseRule`. `splitCommand` cuts a line on `;`,
    `&`, `&&`, `||`, `|` and line breaks outside quotes: every command needs an allow
    rule, one denied command denies the line. A line with substitution, redirection or
    a subshell is not split, so only an exact rule covers it. The block list is regexes
    over the whole command: `sudo`, deleting `/` or `~`, disk devices, a download piped
    to a shell, fork bombs, `.env*` (not `.env.example`), `~/.ssh`, mini-coder's settings.
    It is a pattern list, not a sandbox. Rules come from `SessionOptions.rules` (nothing
    supplies them until phase 6) and from "always" answers, which add an allow rule: a
    file tool as a whole, a command only verbatim.
  - `settings.ts` — `loadSettings(home, root)` merges `~/.mini-coder/settings.json`
    with `<project>/.mini-coder/settings.json`: `model`, `mode`,
    `permissions: { allow, deny }`, `providers: { <name>: { apiKey, baseUrl } }`. The
    project file is not trusted: only its `model` and `permissions.deny` count. A file
    that is not valid JSON, or names an unknown mode, model or rule, is refused with its
    path. Flags win over settings.
  - `memory.ts` — `loadMemory(home, root)`, once per session: prompt text from
    `AGENTS.md` (user, then project), `MEMORY.md` (user, then
    `~/.mini-coder/projects/<slug>/MEMORY.md`) and a skill list (`skills/<name>/SKILL.md`
    with a `description:` line; a project skill replaces a personal one of the same
    name). Tools: `skill(name)` returns the file, and exists only when there are skills;
    `remember(fact, scope)` appends one line; `recall(query)` (see `sessions.ts`). No size cap or cleanup yet.
  - `sessions.ts` — the session log, `~/.mini-coder/projects/<slug>/sessions/<time>-<id>.jsonl`:
    one JSON line per turn with `messages` (what a replay shows) and `history` (what the
    turn added for the model); `/clear` and compaction write a `reset` line. A write that
    fails is reported as a notice and the session goes on unsaved. `sessionFile(home,
    root, resume)` names a new file or finds the latest. `recallTool` searches the
    project's logs for turns containing every word of a query, newest first, 10 at most.
  - Resume and compaction live in `session.ts`. A `logFile` that already has turns is
    resumed: the history is rebuilt from it and one `replay` message is sent. Compaction
    asks the model for a summary (`COMPACT_PROMPT` in `prompt.ts`) and replaces the
    history with it: automatically before a turn that starts above
    `limits.compactAtTokens` (120k), or on `/compact`, which runs as a turn of its own.
    Never in the middle of a turn.
  - `checkpoints.ts` (per-turn file snapshots for `/undo`), `prompt.ts` (rules → tools →
    environment), `model.ts` (`provider:model`, default `openrouter:z-ai/glm-5.3-flash`).
- **`packages/coder-tools`** — `read_file` (numbered lines, offset/limit, no binaries,
  remembers the mtime), `edit_file` (needs a prior read and an unchanged file, an exact
  unique match or `replace_all`, checkpoints first), `write_file` (creates a file and its
  folders, or overwrites one that was read and is unchanged; checkpoints first), `glob`
  (paths matching a glob, sorted, 200 at most), `grep` (JavaScript regex, line by line,
  `path:line:text`, optional `path`, `glob` and `ignore_case`, 200 matches at most;
  skips binaries and files over 1 MB), `bash` (own process group killed on timeout or
  Esc, `cd` carried over via file descriptor 3, stdin closed, background jobs do not
  hang it). `glob` and `grep` share one walk in plain Node: no symlinks, no `.git` or
  `node_modules`, no `.gitignore` (so no `rg` yet). `paths.ts`: realpath through the
  nearest existing folder, inside the project, never `.env*` (except `.env.example`),
  `~/.ssh`, `~/.mini-coder` or `.mini-coder/settings*.json`.
- **`apps/coder`** — one command, one process. `src/main.ts` reads the flags, builds
  the core and hands it to one of the two UIs; a model or mode that cannot be used
  exits 2. `--resume` continues the folder's most recent session.
  - `src/core.ts` — `startCore({ cwd, model?, mode? })` wires core + tools + `llm` (the
    only place they meet) and returns a `Core`. Messages the session sends before the
    UI sets its handler are kept and delivered first. It reads settings and memory from
    `~/.mini-coder` and the project, and passes provider keys from settings to `llm`.
  - `src/ui/headless.ts` — `mini-coder -p "<prompt>" [--model provider:model] [--mode …]`:
    one turn, reply text on stdout, every permission prompt denied. Exit 0 on
    `end_turn`, 1 on any other stop, 130 on Ctrl+C (the turn is stopped first), 2 on bad
    arguments.
  - `src/ui/fold.ts` — view state is `fold(state, action)` over the core's messages plus
    what the user sent: an append-only list of user, assistant, tool and
    notice items. Pure; sending a message marks the turn running at once.
  - `src/ui/App.tsx`, `src/ui/interactive.tsx` — `mini-coder` with no prompt: the Ink
    session (needs a terminal), laid out like Claude Code. A welcome box, then the
    transcript: `> ` user lines, `⏺` replies rendered as markdown, and tool cards
    (`⏺ Bash(cmd)`, `Read(path)`, `Update(path)`) with a `⎿` result — the first 4 output
    lines, a line count for reads, a red/green diff for edits. Finished items are
    printed once (`<Static>`); only the last one redraws. Below: a spinner with elapsed
    time and tokens, queued messages, a bordered input box, and a footer with the model
    and mode.
  - Permission prompt: the command, or the edit as a diff, in full (capped at 20 lines
    with a visible count), then three choices — yes, yes and don't ask again, no —
    picked with ↑↓ + Enter or 1-3. It ignores keys for its first 600 ms, so typing
    ahead cannot approve a call.
  - Input (`src/ui/input.ts`, pure): one line, cursor with ← → Ctrl+A/E, Ctrl+U clears,
    ↑ ↓ recall sent messages, pasted line breaks become spaces. Input typed during a
    turn is queued and sent when the turn ends. Esc aborts the turn and drops the
    queue. `/clear`, `/undo`, `/model`, `/compact` go to the core; `/help` lists them;
    `/quit` or Ctrl+C twice exits. Ink and React load only on this path.
  - `build.ts` — `pnpm --filter @mini-agent/coder build` bundles everything into
    `dist/mini-coder.mjs` (esbuild, one file, Node 22+), the package's `bin`. The API
    key comes from the user's settings, else the environment (`OPENROUTER_API_KEY`, …).
  - Tests: `test/headless.test.ts` runs `-p` as a real process against a local fake of
    OpenRouter. `test/ui.test.ts` covers the fold, the input line, and fails if `ui/`
    imports anything but `coder-core/wire`, `ink-markdown`, Ink, React or Node. The Ink view has no automated
    test.

### 3.11 `packages/ink-markdown`

`<Markdown>` for Ink, used by `apps/tui` and `apps/coder`. `markdown-parser.ts` (pure,
tested) covers headings, emphasis, inline code, fenced blocks, lists, quotes, rules and
links; `Markdown.tsx` maps that onto Ink. Tables and images are deliberately
unsupported — a terminal cannot show them — and anything unrecognised falls through as
plain text.

---

## 4. Auth model

No self-registration. `ADMIN_EMAIL`/`ADMIN_PASSWORD` seed one admin at startup
(`services/bootstrap.service.ts`, no-op once that account exists); every other account is
created by an admin via `POST /admin/users`. Passwords: salted `scrypt`, timing-safe
compare (`services/auth.service.ts`). JWT carries `sub`/`email`/`role`. `requireAuth`
(`verifyToken` + `loadCurrentUser`) runs on every protected route: it verifies the token,
then reads role and `blocked` from the database, so a role change or block applies on the
next request, not at token expiry. A blocked account gets 403 on login and on every
request. Role `user` reaches chat, conversations and schedules; `requireAdmin` guards only
`/admin/*`. Repeated failed logins lock the account for a
configurable window (`LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCKOUT_MINUTES`).

## 5. Deployment

`deploy/docker-compose.yml` runs the published GHCR images — Postgres, API, worker, and
nginx serving the web app. The frontend holds no API URL: it calls relative `/api` paths
and nginx forwards them over the compose network, with the upstream rendered from
`API_HOST`/`API_PORT` at container start rather than baked into the image. A one-shot `db-init`
service applies `packages/db/schema.sql` (baked into the API image, idempotent, re-run on
every deploy) before anything else starts. See [`docs/deploy.md`](deploy.md).

## 6. Local dev

See [`README.md`](../README.md) for setup/run instructions — this doc is a reference for
what exists, not a getting-started guide.

## 6. CI/CD

`.github/workflows/release-images.yml` — builds and pushes the three deployable images to
GHCR. Triggered only by pushing a version tag (`v*`); branch pushes do nothing.

| App | Image |
|---|---|
| `apps/api` | `ghcr.io/chiragthapa777/mini-harness/api` |
| `apps/worker` | `ghcr.io/chiragthapa777/mini-harness/worker` |
| `apps/web` | `ghcr.io/chiragthapa777/mini-harness/web` |

The three build in parallel via a matrix, each from the repo root as build context (the
Dockerfiles copy workspace manifests, so an app-scoped context would break `pnpm install`).
Auth is the workflow's own `GITHUB_TOKEN` with `packages: write` — no PAT or secret to
manage. `docker/metadata-action` turns `v1.4.0` into tags `1.4.0`, `1.4`, `1`, and
`latest`; a pre-release tag (`v1.4.0-rc.1`) publishes the full version only and leaves
`latest` where it was. Layers cache in GitHub Actions cache, scoped per app.

Builds are `linux/amd64` only — arm64 would need QEMU emulation for `pnpm install`, which
roughly triples build time. Add `linux/arm64` to `platforms` if the images need to run on
Apple Silicon or Graviton.

**One manual step, once:** GHCR packages are created private on first push. After the first
tag, open each package under github.com/users/chiragthapa777/packages and set its visibility
to public. Publishing anonymously-pullable images is a deliberate exposure decision, so the
workflow does not flip that automatically.
