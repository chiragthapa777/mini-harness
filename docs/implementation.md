# Implementation

`docs/architecture.md` is the plan — three layers, the loop, the memory model, LLM Ops.
This is the other half: what actually exists in the repo today, file by file, so anyone
picking up the project can tell shipped from planned without reading every source file.

For the punch list of what's *not* built yet, see [`TODO.md`](../TODO.md) — items 4–13
there are gaps found by comparing this doc against `docs/architecture.md`. For how one
run actually works step by step (the loop, tool calls, working memory), see
[`docs/agent-run.md`](agent-run.md).

---

## 1. Status snapshot

| Layer (from architecture.md) | State |
|---|---|
| Gateway — web app | Built (`apps/web`) |
| Gateway — TUI, WhatsApp/Telegram bot | Not built (TODO 5, 13) |
| Agentic loop, tool protocol, guardrails | Built (`packages/core`) |
| Procedural / semantic / episodic memory | Built (`packages/memory`) |
| Memory consolidation (episodic → semantic) | Code exists, **not wired to anything** — no caller, no `Summarizer` (TODO 7) |
| LLM Ops — trace | Built (per-run trace, admin Traces tab) |
| LLM Ops — eval / observe / diagnose / gate / release | Not built (TODO 8) |
| Cron / scheduled jobs / background job runner | Not built (TODO 9, 10) |
| Named agent personas (per-persona system prompt/config) | Not built — one global `SYSTEM_PROMPT` today (TODO 11) |
| MCP support | Not built (TODO 6) |

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

### 2.2 `apps/api` — Express

Structured as routes / services / middleware / utils (`src/`):

```
app.ts                        express app factory, mounts every router
index.ts                      entrypoint — bootstrap admin, listen
logger.ts                     timestamped console wrapper
middleware/auth.middleware.ts requireAuth, requireAdmin, AuthedRequest
routes/                       health, auth, admin, conversations, chat — one file each
services/                     auth, users, conversations, traces, tools, run, bootstrap
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
| GET | `/conversations` | user | own conversations |
| POST | `/conversations` | user | create one |
| GET | `/conversations/:id/messages` | user | messages in one (own only) |
| DELETE | `/conversations/:id` | user | delete (own only) |
| POST | `/chat` | user | one run, full reply |
| POST | `/chat/stream` | user | one run, SSE |

`toolsFor(userId)` (`services/tools.service.ts`) builds the per-run tool list: the
stateless defaults from `packages/core` plus two memory tools bound to the caller
(`remember`, `search_memory`).

---

## 3. Packages

### 3.1 `packages/core` — the harness

- **`loop.ts` / `stream.ts`** — the agentic loop, non-streaming and streaming twins.
  Each iteration: call the model, parse `tool_call` fences out of the reply, run the
  matching tool handlers, feed results back as the next user turn. Guardrails:
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
- **`config.ts`** — `SYSTEM_PROMPT` (one global constant today — see TODO 11),
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
- **Episodic** (`episodic.ts`) — `messages` table. `recall` unions a recency query and a
  relevance query (RAG); `saveMessage` embeds and stores every turn.
- **Consolidation** (`consolidate.ts`) — gate (only run past N unconsolidated messages),
  `Summarizer` interface, writes distilled facts, marks messages consolidated. **Nobody
  calls `consolidate()` and no `Summarizer` is implemented** — episodic memory grows
  forever today; semantic memory only grows from the agent's own `remember` tool.

### 3.4 `packages/db`

Lazy singleton `pg.Pool`, a `query()` helper, and `toVector()` for pgvector literals.
Schema (`schema.sql`, applied on first boot of an empty Postgres volume):

| Table | Purpose |
|---|---|
| `users` | auth — email, password hash, role, lockout state |
| `conversations` | one row per chat thread |
| `messages` | episodic log — role, content, embedding, `consolidated_at` |
| `events` | dated events, separate from chat turns (defined, not yet written to by any code path) |
| `facts` | semantic memory — kind, content, embedding, source |
| `traces` | one row per agent run — tokens, latency, stop reason, steps (jsonb), system prompt |

### 3.5 `packages/search`

Backend for the three web tools. `SearchProvider` interface, `DuckDuckGoProvider` the
only implementation today (keyless). `guardedFetch`/`assertPublicUrl`
(`http.ts`) refuse private/loopback addresses on every redirect hop — the guard between
model-chosen URLs and the network the harness runs in. `scrape.ts` strips boilerplate to
markdown for `scrape_url`.

### 3.6 `packages/config`

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
