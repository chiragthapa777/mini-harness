## TODO

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

- [ ] 4. add support for adding semantic memory data from file upload
  - upload endpoint (apps/api) that chunks a file and calls `writeFact` per chunk (packages/memory/src/semantic.ts)
  - needs a chunking strategy (size/overlap) — nothing in the repo does this today
  - admin UI: file picker on the MemoryTab (apps/web/src/components/admin/MemoryTab.tsx)
  - decide accepted types first (txt/md to start; PDF needs a parser dependency)

- [ ] 5. create a tui just, from ink node js
  - new `apps/tui` package, Ink + React for the terminal UI
  - talks to the same `/chat` or `/chat/stream` endpoints apps/web already uses — no new backend needed for a plain chat TUI
  - auth: reuse the JWT login flow (apps/api/src/routes/auth.routes.ts), token cached locally (e.g. `~/.mini-agent/token`)
  - this is also the natural home for the terminal coding agent (#11) once that persona exists

- [ ] 6. add support for mcp
  - MCP client wiring in packages/core so `AgentTool[]` can include tools proxied from an MCP server, alongside the existing hand-written tools (packages/core/src/tools.ts)
  - config for which MCP servers to connect to (packages/config)
  - decide how MCP tool results map onto our own `tool_call` fence protocol (packages/core/src/protocol.ts) — no provider-native function calling in this repo, so MCP tools need to render through the same catalog/parsing path as everything else

- [ ] 7. wire up memory consolidation
  - `consolidate()` (packages/memory/src/consolidate.ts) is fully written — gate, `writeFact`, `markConsolidated` — but has zero callers anywhere in the repo, and no `Summarizer` implementation exists to pass it
  - needs: (a) a `Summarizer` — a cheap-model call that turns `StoredMessage[]` into fact strings, (b) somewhere to trigger it — after each chat turn in apps/api/src/services/run.service.ts, or a separate scheduled job once #9/#10 exist
  - until this is wired, episodic messages accumulate forever and semantic memory only grows from the agent's own `remember` tool

- [ ] 8. build the LLM Ops eval/diagnose/gate/release pipeline (docs/architecture.md §4)
  - only "trace" exists (apps/api/src/services/traces.service.ts, admin Traces tab) — captures tokens/latency/steps/system prompt per run, nothing more
  - EVAL: needs both an LLM-as-judge pass and deterministic checks (exact-match/schema) scored against a trace
  - OBSERVE: trace data already has the numbers; missing is anything that watches them (alerting/thresholds), not just an admin table someone has to look at
  - DIAGNOSE: localize a failing trace to a stage — retrieval, prompt, tool, or model config — nothing does this today
  - GATE + RELEASE: pass/fail decision that either loops back to trace or ships a fix (prompt/config bump, reflected in `PROMPT_VERSION`) — no automation, `PROMPT_VERSION` is bumped by hand today

- [ ] 9. add a background job runner (queue + worker process) so work can run outside a request/response cycle
  - decide queue backing — Postgres-backed (`SELECT ... FOR UPDATE SKIP LOCKED` on a `jobs` table, no new datastore, fits "no new frameworks/datastores without asking") vs. a real queue
  - worker process needs its own entrypoint (new `apps/worker`, or a mode flag on `apps/api`) that polls/consumes jobs and runs the agent loop per job (packages/core/src/loop.ts already returns a plain `RunResult` — reusable outside Express)
  - a job run still needs a trace, same as a chat run — reuse `services/traces.service.ts`, but `conversation_id` may be null for a job with no chat behind it (schema already allows this: `packages/db/schema.sql`)

- [ ] 10. add cron/scheduled jobs — user can create a scheduled job (prompt + cadence), persisted, fired by the job runner
  - depends on #9 (nothing to fire a schedule into without a job runner)
  - new `scheduled_jobs` table (packages/db/schema.sql): user_id, prompt, cadence (cron expr), agent persona (see #11), enabled/paused, last_run_at, next_run_at
  - API: CRUD routes (apps/api/src/routes/, new `jobs.routes.ts`) + web UI to add/edit/pause a schedule
  - a scheduler tick (cron-parser + a periodic check, or Postgres `pg_cron` if we're willing to lean on the extension) enqueues due jobs onto the runner from #9

- [ ] 11. add named agent personas/profiles instead of the single global SYSTEM_PROMPT — each with its own system prompt, model config, and guardrails ("gate")
  - today: one hardcoded `SYSTEM_PROMPT` + one `PROMPT_VERSION` (packages/core/src/config.ts) used by every run regardless of caller
  - needs a persona registry (config, versioned like the rest — CLAUDE.md: "prompts... are config, not inlined at call sites"): id, system prompt, model/maxTokens, guardrails, allowed tools
  - `runConfig()` and `WorkingMemory.systemPrompt` (packages/core/src/types.ts) already take these per-call — the missing piece is a lookup table and a caller passing the right persona id in, not a core loop change
  - three personas asked for:
    - **chat web QnA agent** — today's default, QnA-tuned, current tool set (web + memory)
    - **job-runner agent** — "job completing" persona: terser, task-completion-oriented system prompt, tuned for running unattended to a defined done-state (depends on #9/#10 to have somewhere to run)
    - **terminal coding agent** — coding-focused system prompt, gets the file read/write tools from #12, lives in the TUI (#5)

- [ ] 12. add sandboxed file read/write tools (path-guarded, like the SSRF guard in packages/search/src/http.ts) so the terminal coding agent can edit files
  - new tools in packages/core/src/tools.ts: read_file, write_file, maybe list_dir — same `AgentTool` shape as the existing calculator/clock/web tools
  - needs a root-jail guard (resolve + reject any path escaping a configured workspace root) mirroring how packages/search/src/http.ts refuses private/loopback addresses on every redirect — same reasoning: paths come from model output, must not be trusted directly
  - only meaningful once the terminal coding persona (#11) exists to grant it — a chat web QnA agent should not get file-write access

- [ ] 13. add a WhatsApp/Telegram bot gateway
  - docs/architecture.md lists this as a gateway surface alongside TUI/web (§2); neither bot exists
  - thin adapter translating inbound bot messages into the same `/chat` (or `/chat/stream`) call apps/web already makes — no core/loop change needed, this is a gateway, not a harness change
  - needs per-platform webhook handling + a way to map a bot user id to a mini-agent user id (packages/db `users` table has no external-id column yet)
