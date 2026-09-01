# mini-agent

A mini harness usable as your personal AI agent.

Architecture: [docs/architecture.md](docs/architecture.md) (diagram: `docs/arch.png`).
Read it before touching the run loop, memory layer, or ops path — it defines the boundaries
those pieces live in.

Implementation: [docs/implementation.md](docs/implementation.md) — what is actually built
today (endpoints, schema, packages, gaps), as opposed to architecture.md's plan.

Agent run walk-through: [docs/agent-run.md](docs/agent-run.md) — how one run works end to
end (working memory, the loop, tool calls, persistence), with file references.

## Tech stack — do not add alternatives

| Concern | Choice |
|---|---|
| Language | TypeScript (everywhere, no plain JS) |
| Frontend | React |
| Backend | Express |
| SQL store | Postgres |
| Vector store | Postgres (`pgvector`) — same database, not a separate vector DB |
| Styling | Tailwind |
| Layout | Monorepo — many apps and packages |
| LLM access | `packages/llm` — our own chat transport over the official provider SDKs |
| Provider | OpenRouter (OpenAI wire format), default model `z-ai/glm-5.3-flash` |
| Cron expressions | `croner` — parsing and next-run only; firing stays DB-driven |

**`packages/llm` is a transport, not a framework.** It gives us one chat
interface across providers and nothing else: `ChatClient` is two methods,
`invoke` and `stream`, over plain `{ role, content }` messages. The loop, the
tool-calling protocol, the guardrails, and the traces are ours — see
`packages/core`. Tool calls do **not** use provider-native function calling:
the agent emits a fenced ```` ```tool_call ```` block and the harness parses
it, so the wire format is identical on every model.

`packages/llm` is the **only** place a provider is named. It wraps the official
SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`), imported lazily so a run
loads only the SDK it needs. Nothing above it may import a provider SDK
directly — if a file outside `packages/llm` names a vendor, that is a bug. There
is no LangChain — it was removed once it became clear the only thing being used
was the chat interface, and its message abstraction was dropping OpenRouter's
reasoning deltas on the way through.

No other frameworks or datastores without asking first. Postgres covers both the relational
side (episodic recency queries) and the embedding side (RAG top-k).

## Repo layout

Monorepo. Deployables in `apps/`, shared code in `packages/`.

- `apps/` — gateway surfaces (TUI, web app, chat bots) and the API server.
- `packages/` — harness core (loop, tools, memory), chat transport (`llm`), shared types, db/schema, UI kit.
- `docs/` — architecture.

Anything imported by more than one app belongs in `packages/`, not copied between apps.

## Shape of the system

- **Gateway** — TUI / web app / WhatsApp-Telegram bot. Only entry point; hands a user prompt to the run.
- **AI Agent Run** — ephemeral. User prompt + chat history + system prompt -> working memory -> agentic loop -> reply. Nothing inside survives the run.
- **Agentic Loop** — LLM (Claude / GPT / Gemini) plus tool access via function calling or MCP. Terminated by end-loop guardrails.
- **Memory** — procedural (files, `skills.md`), semantic (durable facts, vector store), episodic (past chat history + dated events, vector store and db). Consolidation runs after N messages.
- **LLM Ops** — one trace per run, eval + observe, diagnose, gate, release.

## Conventions

- Anything that must outlive a run gets written to a memory store. Never keep state in the loop.
- Retrieval is per store: procedural loads direct, semantic is RAG top-k, episodic is RAG for relevance plus SQL for recency.
- Prompts, model config, tool definitions, and RAG params are **config** — versioned and released, not inlined at call sites.
- Guardrails (iteration cap, token/cost budget, output validation) are required on any new loop.
- When a task or feature is finished, update [docs/implementation.md](docs/implementation.md)
  in the same change — new/changed endpoints, schema, packages, tools, or config. If the
  shape of the system itself changed (not just what's built inside it), update
  [docs/architecture.md](docs/architecture.md) too. Docs must never lag the code.
