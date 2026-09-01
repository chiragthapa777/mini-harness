## TODO

Items 4–11 are the next chunk of work, in dependency order: build the job framework
first, then the scheduler, then move the slow memory work (embedding, summarizing,
consolidation) onto it, then wire what that produces back into the run loop.

- [x] 1. create a good frontend ui github ui inspired and make it mobile compatible as well, it inspiration from the chatgpt and claude chat for ui, simple and minimal
  - React + Tailwind, GitHub-dark-inspired minimal chat UI (apps/web/src) — sidebar with conversation list, collapsible on mobile via `MenuButton`/`toggleSidebar` (apps/web/src/components/Layout.tsx)
  - two response modes sharing one URL scheme via `?mode=stream`, not separate paths (apps/web/src/pages/Chat.tsx routes to ChatClassic.tsx / ChatStream.tsx)
  - `ChatClassic` — plain request/response against `/chat`; `ChatStream` — SSE against `/chat/stream`, renders thinking/tool-calls/text live (apps/web/src/components/Message.tsx)
  - responsive throughout via Tailwind `sm:` breakpoints, safe-area padding for the composer on mobile (`env(safe-area-inset-bottom)` in ChatClassic.tsx/ChatStream.tsx)

- [x] 2. create a authentication using email and password simple, jwt auth and integrate with web ui as well.
  - no self-registration — accounts created by an admin or the startup bootstrap (`ensureBootstrapAdmin`, apps/api/src/services/bootstrap.service.ts, reads `ADMIN_EMAIL`/`ADMIN_PASSWORD`)
  - password hashing via `scrypt`, salted, timing-safe compare (apps/api/src/services/auth.service.ts); JWTs signed with `JWT_SECRET`, carry `sub`/`email`/`role`
  - failed-login lockout: N attempts within a window locks the account for a configurable duration (`recordFailedLogin`, apps/api/src/services/users.service.ts)
  - Express middleware `requireAuth`/`requireAdmin` (apps/api/src/middleware/auth.middleware.ts) gate every non-public route
  - web side: `AuthProvider`/`useAuth` (apps/web/src/lib/AuthContext.tsx) validates a stored token against `/auth/me` once on load, then holds the user in memory; `RequireAuth`/`RequireAdmin` route guards (apps/web/src/components/) protect the chat and admin routes respectively

- [x] 3. create a ui for viewing all the memory we have for a user only admin can view that for all users.
  - `GET /admin/facts?userId=` (apps/api/src/routes/admin.routes.ts, backed by `listFacts` in packages/memory/src/semantic.ts) — paginated, filterable by kind, admin-only
  - `MemoryTab` in the admin dashboard (apps/web/src/components/admin/MemoryTab.tsx) — pick a user, browse their semantic facts
  - sits alongside `UsersTab` (account management) and `TracesTab` (LLM Ops trace viewer, includes the captured system prompt per run) in the same tabbed Admin page (apps/web/src/pages/Admin.tsx)

- [x] 4. background job framework — `jobs` table + worker process, so work can run outside a request/response cycle
  - **foundation for 5–11; nothing else in this block can start until it exists**
  - Postgres-backed queue, no new datastore (CLAUDE.md: no new frameworks/datastores without asking) — `SELECT ... FOR UPDATE SKIP LOCKED` claim on a `jobs` table
  - `jobs` table (packages/db/schema.sql): id, user_id, type (`embed_row` / `summarize_conversation` / `consolidate_user` / `dedupe_facts` / `agent_run`), payload jsonb, status (`queued`/`running`/`succeeded`/`failed`), attempts, max_attempts, last_error, scheduled_for, started_at, finished_at, created_at — plus a partial index on `(status, scheduled_for)` for the claim query
  - one table is both queue and audit log — the status columns *are* the tracking, no separate journal
  - a typed job registry in a new `packages/jobs`: `type -> handler(payload)`, so enqueue sites stay type-checked and the worker has one dispatch point
  - retry with backoff on failure, dead-letter at `attempts >= max_attempts` (stays in the table as `failed`, visible in #5)
  - worker entrypoint: new `apps/worker` (or a mode flag on apps/api) that polls, claims, dispatches, and can run the agent loop per job — `runLoop` (packages/core/src/loop.ts) already returns a plain `RunResult`, reusable outside Express
  - a job that runs the agent loop still writes a trace (services/traces.service.ts); `traces.conversation_id` is already nullable for a job with no chat behind it. A job that only embeds writes no trace — keep `jobs` and `traces` separate, linked by id where both exist

- [x] 5. admin panel for background jobs
  - depends on #4
  - `GET /admin/jobs` with status/type/user filters + pagination, and a retry/requeue action (apps/api/src/routes/admin.routes.ts, admin-only like the existing facts route)
  - new `JobsTab` (apps/web/src/components/admin/, alongside MemoryTab/TracesTab/UsersTab, registered in apps/web/src/pages/Admin.tsx) — queue depth by status, recent failures, per-job payload/attempts/last_error
  - link a job to its trace where it has one, so a failed `agent_run` job is one click from the trace that failed

- [x] 6. cron / scheduled jobs — a scheduler tick that enqueues due work onto #4
  - depends on #4
  - two kinds of schedule, one mechanism:
    - **system schedules** — internal maintenance defined in config (packages/config): the 5-minute conversation-summary tick (#8), consolidation (#10), fact dedup (#11)
    - **user schedules** — `scheduled_jobs` table: user_id, prompt, cadence (cron expr), agent persona (#16), enabled/paused, last_run_at, next_run_at
  - scheduler = cron-parser + a periodic check that enqueues due rows into `jobs`; prefer this over Postgres `pg_cron` so scheduling stays in the app and needs no extra extension
  - overlap guard: a schedule must not enqueue a second job while its previous one is still `queued`/`running`
  - API: CRUD routes (apps/api/src/routes/jobs.routes.ts) + web UI to add/edit/pause a user schedule

- [x] 7. move embedding off the request path into a background job
  - depends on #4
  - today `saveMessage` (packages/memory/src/episodic.ts) and `writeFact` (packages/memory/src/semantic.ts) both `await embed(content)` before their INSERT, so every chat turn pays an embedding round-trip inline and holds the request open
  - insert with `embedding IS NULL` immediately, enqueue an `embed_row` job, backfill the column when it runs
  - `recall()` and `searchFacts()` already filter `WHERE embedding IS NOT NULL`, so a not-yet-embedded row degrades to recency-only rather than breaking — that is the property that makes this safe to make async
  - one generic `embed_row` job type — `{ table, id }` for `messages` / `facts` / `events` — not three handlers
  - claim/retry comes from #4; add a backfill sweep that re-enqueues rows still `NULL` past some age, so a job lost before #4's retry policy existed doesn't leave a permanent hole

- [x] 8. episodic dated events from conversation summaries, not raw messages
  - depends on #4, #6, #7
  - today `recall()` (packages/memory/src/episodic.ts) reads `messages` directly — SQL recency + per-message embedding similarity — so retrieval competes against every individual turn, and the `events` table (packages/db/schema.sql) has **zero** readers or writers anywhere in the repo
  - each conversation gets a rolling short summary: new `summary` text column on `conversations`, plus `summary_updated_at` and `summary_message_id` (watermark = last message folded in)
  - hard cap the summary at **under 200 words** — it is the retrieval unit, not an archive; regenerating rewrites the column in place rather than appending
  - that summary is the episodic dated event: one `events` row per conversation (`summary`, `occurred_at` = conversation's last message time, `embedding` over the summary), upserted whenever the summary is regenerated — needs a unique key on the source conversation so it upserts instead of duplicating
  - `summarize_conversation` job, driven by a **5-minute** system schedule (#6): select conversations where the newest `messages.id` is ahead of `summary_message_id`, one job per conversation. Nothing new means nothing enqueued, so an idle system does no LLM work
  - idempotent and re-entrant — a job that dies mid-run leaves the watermark unmoved and is picked up next tick
  - the summarizer is a cheap-model call over `ChatClient` (packages/llm); same implementation serves #10

- [x] 9. integrate summarized episodic memory into the run loop and system prompt
  - depends on #8
  - `recall()` switches to two sources: relevance over `events` summaries (RAG top-k) + SQL recency over raw `messages` for the current/recent window only — long-tail retrieval stops being per-turn
  - `workingMemory()` (apps/api/src/services/run.service.ts:59) currently flattens episodes to `"<iso> <role>: <content>"`; dated event summaries need their own rendering (`<date> — <summary>`), so `WorkingMemory` (packages/core/src/types.ts) likely grows a field rather than overloading `episodic`
  - `buildSystem()` (packages/core/src/loop.ts:116) renders sections by heading — a summary-based section reads differently from raw turns ("What happened before" vs. per-conversation recaps); split the heading rather than mixing both shapes under one bullet list
  - the `recall_memory` tool (apps/api/src/services/tools.service.ts:39) hits the same `recall()`, so it inherits the change — check its output still reads sensibly when episodes are summaries
  - bump `PROMPT_VERSION` (packages/core/src/config.ts) with the prompt-shape change so traces before/after are distinguishable

- [ ] 10. consolidation + fact extraction job for semantic memory
  - depends on #4, #6; supersedes the old "wire up memory consolidation" item
  - `consolidate()` (packages/memory/src/consolidate.ts) is fully written — gate, `writeFact`, `markConsolidated` — but has **zero callers** anywhere in the repo, and no `Summarizer` implementation exists to pass it
  - build the `Summarizer`: a cheap-model call that turns `StoredMessage[]` into fact strings; same LLM plumbing as #8's conversation summarizer, different prompt (durable facts vs. narrative recap)
  - run it as a `consolidate_user` job on a schedule (#6), not inline after each chat turn — keeps the request path free and lets the `afterN` gate batch properly
  - prompt + gate live in config (packages/config), versioned like the rest — not inlined at the call site
  - until this ships, `messages.consolidated_at` is never set and semantic memory only grows from the agent's own `remember` tool

- [ ] 11. fact consolidation — dedup, merge, and supersede facts in semantic memory
  - depends on #10 (nothing generates enough facts to need this until consolidation runs on a schedule)
  - the problem: `writeFact` (packages/memory/src/semantic.ts:85) is a blind INSERT — no dedup, no update path. `updated_at` is never touched after insert, so "user lives in Kathmandu" written five times is five rows competing for the same top-k slots, and a *changed* fact never replaces the stale one it contradicts
  - proposed policy (decide before building):
    - **write-time near-dup check** — embed first (via #7), cosine-compare against the user's existing facts, and above a threshold update the existing row (`content`, `updated_at`, `source`) instead of inserting
    - **periodic `dedupe_facts` job** — per user, cluster near-duplicate facts by embedding distance, hand each cluster to a cheap model that returns one merged fact, keep the oldest row id as the survivor so references stay stable
    - **supersede, don't delete** — new `superseded_by bigint` + `archived_at timestamptz` on `facts`; retrieval filters `archived_at IS NULL`. Keeps an audit trail and makes a bad merge reversible
    - **contradiction handling** — the merge step must be allowed to *replace* rather than concatenate when two facts conflict; recency wins, and the losing row is archived, not merged in
    - **cap per user** — a max fact count with archive-the-least-relevant, so top-k quality does not decay as the table grows
  - admin visibility: MemoryTab (apps/web/src/components/admin/MemoryTab.tsx) should show archived/superseded facts under a filter, otherwise a merge looks like data loss

- [ ] 12. add support for adding semantic memory data from file upload
  - upload endpoint (apps/api) that chunks a file and calls `writeFact` per chunk (packages/memory/src/semantic.ts)
  - needs a chunking strategy (size/overlap) — nothing in the repo does this today
  - admin UI: file picker on the MemoryTab (apps/web/src/components/admin/MemoryTab.tsx)
  - decide accepted types first (txt/md to start; PDF needs a parser dependency)
  - chunk embedding should go through the async path from #7 — a 200-chunk upload must not embed inline

- [ ] 13. create a tui just, from ink node js
  - new `apps/tui` package, Ink + React for the terminal UI
  - talks to the same `/chat` or `/chat/stream` endpoints apps/web already uses — no new backend needed for a plain chat TUI
  - auth: reuse the JWT login flow (apps/api/src/routes/auth.routes.ts), token cached locally (e.g. `~/.mini-agent/token`)
  - this is also the natural home for the terminal coding agent (#16) once that persona exists

- [ ] 14. add support for mcp
  - MCP client wiring in packages/core so `AgentTool[]` can include tools proxied from an MCP server, alongside the existing hand-written tools (packages/core/src/tools.ts)
  - config for which MCP servers to connect to (packages/config)
  - decide how MCP tool results map onto our own `tool_call` fence protocol (packages/core/src/protocol.ts) — no provider-native function calling in this repo, so MCP tools need to render through the same catalog/parsing path as everything else

- [ ] 15. build the LLM Ops eval/diagnose/gate/release pipeline (docs/architecture.md §4)
  - only "trace" exists (apps/api/src/services/traces.service.ts, admin Traces tab) — captures tokens/latency/steps/system prompt per run, nothing more
  - EVAL: needs both an LLM-as-judge pass and deterministic checks (exact-match/schema) scored against a trace
  - OBSERVE: trace data already has the numbers; missing is anything that watches them (alerting/thresholds), not just an admin table someone has to look at
  - DIAGNOSE: localize a failing trace to a stage — retrieval, prompt, tool, or model config — nothing does this today
  - GATE + RELEASE: pass/fail decision that either loops back to trace or ships a fix (prompt/config bump, reflected in `PROMPT_VERSION`) — no automation, `PROMPT_VERSION` is bumped by hand today
  - eval runs are batch work — they belong on the job framework (#4), not in a request

- [ ] 16. add named agent personas/profiles instead of the single global SYSTEM_PROMPT — each with its own system prompt, model config, and guardrails ("gate")
  - today: one hardcoded `SYSTEM_PROMPT` + one `PROMPT_VERSION` (packages/core/src/config.ts) used by every run regardless of caller
  - needs a persona registry (config, versioned like the rest — CLAUDE.md: "prompts... are config, not inlined at call sites"): id, system prompt, model/maxTokens, guardrails, allowed tools
  - `runConfig()` and `WorkingMemory.systemPrompt` (packages/core/src/types.ts) already take these per-call — the missing piece is a lookup table and a caller passing the right persona id in, not a core loop change
  - three personas asked for:
    - **chat web QnA agent** — today's default, QnA-tuned, current tool set (web + memory)
    - **job-runner agent** — "job completing" persona: terser, task-completion-oriented system prompt, tuned for running unattended to a defined done-state (runs on #4/#6)
    - **terminal coding agent** — coding-focused system prompt, gets the file read/write tools from #17, lives in the TUI (#13)

- [ ] 17. add sandboxed file read/write tools (path-guarded, like the SSRF guard in packages/search/src/http.ts) so the terminal coding agent can edit files
  - new tools in packages/core/src/tools.ts: read_file, write_file, maybe list_dir — same `AgentTool` shape as the existing calculator/clock/web tools
  - needs a root-jail guard (resolve + reject any path escaping a configured workspace root) mirroring how packages/search/src/http.ts refuses private/loopback addresses on every redirect — same reasoning: paths come from model output, must not be trusted directly
  - only meaningful once the terminal coding persona (#16) exists to grant it — a chat web QnA agent should not get file-write access

- [ ] 18. add a WhatsApp/Telegram bot gateway
  - docs/architecture.md lists this as a gateway surface alongside TUI/web (§2); neither bot exists
  - thin adapter translating inbound bot messages into the same `/chat` (or `/chat/stream`) call apps/web already makes — no core/loop change needed, this is a gateway, not a harness change
  - needs per-platform webhook handling + a way to map a bot user id to a mini-agent user id (packages/db `users` table has no external-id column yet)
