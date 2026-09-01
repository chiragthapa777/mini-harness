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
| Gateway — TUI, WhatsApp/Telegram bot | Not built (TODO 13, 18) |
| Agentic loop, tool protocol, guardrails | Built (`packages/core`) |
| Procedural / semantic / episodic memory | Built (`packages/memory`) |
| Memory consolidation (episodic → semantic) | Built — `extractFacts` + `consolidate_user` job on a schedule |
| LLM Ops — trace | Built (per-run trace, admin Traces tab) |
| LLM Ops — eval / observe / diagnose / gate / release | Not built (TODO 15) |
| Background job runner (queue + worker) | Built (`packages/jobs`, `apps/worker`) |
| Cron / scheduled jobs | Built (`packages/jobs` scheduler, `scheduled_jobs`) |
| Named agent personas (per-persona system prompt/config) | Not built — one global `SYSTEM_PROMPT` today (TODO 16) |
| MCP support | Not built (TODO 14) |

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
- **Admin dashboard** (`src/pages/Admin.tsx`), three tabs, each its own component under
  `src/components/admin/`:
  - `UsersTab` — list/create users, change role, clear a lockout.
  - `MemoryTab` — browse any user's semantic facts (admin-only).
  - `TracesTab` — filter/browse traces by user, model, error status, date range; the list
    itself shows a truncated system prompt per row, the expanded detail view has the
    full assembled system prompt plus per-step tool calls for that run.
  - `SchedulesTab` — every schedule, system and user, with pause/resume. Users manage
    their own at `/schedules` (cron preview shows the next firings in local time).
  - `JobsTab` — queue depth by status, filter by status/type/user, expand a job for its
    payload, result, timings and error, retry a dead-lettered one. Polls every 5s
    (a queue is only useful live). A job that ran the agent loop stores its `traceId`,
    so the row expands straight into the shared `TraceDetail` view.

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
| POST | `/auth/login` | — | email+password → JWT; 423 if locked out |
| GET | `/auth/me` | user | current user from the token |
| GET | `/admin/users` | admin | list users |
| POST | `/admin/users` | admin | create a user |
| PATCH | `/admin/users/:id` | admin | change role and/or clear lockout |
| GET | `/admin/facts` | admin | a user's semantic facts, paginated |
| GET | `/admin/traces` | admin | traces, filterable by user/model/error/date |
| GET | `/admin/traces/:id` | admin | one trace, full detail incl. system prompt |
| GET | `/admin/jobs` | admin | background jobs, filterable by status/type/user |
| GET | `/admin/jobs/stats` | admin | queue depth by status and type |
| GET | `/admin/jobs/:id` | admin | one job |
| POST | `/admin/jobs/:id/retry` | admin | requeue a finished job (409 if still live) |
| GET | `/admin/schedules` | admin | every schedule, system and user |
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

---

## 3. Packages

### 3.1 `packages/core` — the harness

- **`loop.ts` / `stream.ts`** — the agentic loop, non-streaming and streaming twins.
  Each iteration: call the model, parse `tool_call` fences out of the reply, run the
  matching tool handlers, feed results back as the next user turn. `buildSystem` renders
  retrieved memory under four headings — *How to act*, *What is known*, *Earlier
  conversations* (dated recaps), *Recent messages* (verbatim window). The last two are
  separate because a recap of an episode and the last few turns are not the same kind of
  thing, and one heading would tell the model they were. Guardrails:
  `maxIterations`, `maxTokensPerRun`. Every run returns a `Trace` — provider, model, the
  **fully assembled system prompt actually sent**, iterations, token counts, latency,
  stop reason, and one `TraceStep` per iteration (tool calls, tokens, latency).
- **`protocol.ts`** — the tool-calling wire format. No provider-native function calling:
  the model emits fenced ` ```tool_call ` blocks (`{"tool": "...", "input": {...}}`),
  parsed the same way on every provider. `ToolCallTextFilter` hides fence contents from
  a live stream token-by-token. `renderToolResults` sends results back as a plain user
  turn.
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
(`ChatClient`). `chatModel(provider, model, maxTokens)` is the only place a provider is
named — `OpenAICompatClient` (OpenRouter/OpenAI), `AnthropicClient`, `GoogleClient`, each
SDK imported lazily. Also owns embeddings (`embed`, `embedQuery`) for the vector stores.

### 3.3 `packages/memory`

- **Procedural** (`procedural.ts`) — reads every `.md` file under `SKILLS_DIR`
  (`skills/`), no search step, loaded straight into working memory.
- **Semantic** (`semantic.ts`) — `facts` table. `searchFacts` (RAG top-k, falls back to
  most-recent when no embedding), `writeFact`, `listFacts` (admin listing, offset-paged,
  no ranking).
- **Conversations** (`conversations.ts`) — the container the episodic log hangs off:
  list/create/delete, messages for one thread, title-from-first-message. Lives here, not
  in an app, because both the API and the worker need it.
- **Episodic** (`episodic.ts`) — `messages` table. `recall` unions a recency query and a
  relevance query (RAG); `saveMessage` embeds and stores every turn.
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
| `users` | auth — email, password hash, role, lockout state |
| `conversations` | one row per chat thread, plus its rolling summary and watermark |
| `messages` | episodic log — role, content, embedding, `consolidated_at` |
| `events` | dated events — one per conversation, holding that conversation's summary; what episodic RAG ranks |
| `facts` | semantic memory — kind, content, embedding, source |
| `traces` | one row per agent run — tokens, latency, stop reason, steps (jsonb), system prompt |
| `jobs` | background work — type, payload, status, attempts, backoff schedule, dedupe key, result |
| `scheduled_jobs` | cron schedules — system (from config, keyed) and user (prompt + cadence), with `next_run_at` and the last job fired |

### 3.7 `packages/search`

Backend for the three web tools. `SearchProvider` interface, `DuckDuckGoProvider` the
only implementation today (keyless). `guardedFetch`/`assertPublicUrl`
(`http.ts`) refuse private/loopback addresses on every redirect hop — the guard between
model-chosen URLs and the network the harness runs in. `scrape.ts` strips boilerplate to
markdown for `scrape_url`.

### 3.8 `packages/config`

The only file allowed to touch `process.env` (`src/index.ts`). Zod-validated,
re-parsed on every `getConfig()` call (not cached at import time) so tests can stub
per-case and a long-lived server never needs a restart to pick up a changed var. See
`.env.example` for the full variable list with explanations.

---

## 4. Auth model

No self-registration. `ADMIN_EMAIL`/`ADMIN_PASSWORD` seed one admin at startup
(`services/bootstrap.service.ts`, no-op once that account exists); every other account is
created by an admin via `POST /admin/users`. Passwords: salted `scrypt`, timing-safe
compare (`services/auth.service.ts`). JWT carries `sub`/`email`/`role`, verified by
`requireAuth` on every protected route. Repeated failed logins lock the account for a
configurable window (`LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCKOUT_MINUTES`).

## 5. Local dev

See [`README.md`](../README.md) for setup/run instructions — this doc is a reference for
what exists, not a getting-started guide.
