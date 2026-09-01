# mini-harness

A mini harness usable as your personal AI agent. Monorepo: web app + API server on
top of a shared harness core (agentic loop, memory, tools).

Architecture details: [docs/architecture.md](docs/architecture.md).

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript |
| Frontend | React (Vite) + Tailwind |
| Backend | Express |
| SQL + vector store | Postgres (`pgvector`) |
| LLM access | `packages/llm` — thin chat transport over official provider SDKs |
| Provider | OpenRouter (OpenAI wire format), default model `z-ai/glm-5.3-flash` |

Tool calls are not provider-native function calling — the agent emits a fenced
```tool_call``` block and the harness parses it, so the wire protocol is identical
across models. See `AGENTS.md` for the full design rationale.

## Repo layout

```
apps/
  api/    Express API — auth, conversations, run loop
  web/    React chat UI
packages/
  core/     agentic loop, tools, guardrails
  llm/      chat transport (only place a provider SDK is named)
  memory/   procedural / semantic / episodic memory + consolidation
  db/       Postgres schema + client
  search/   web search & scrape tools
  config/   shared config loading
docs/       architecture
```

## Prerequisites

- Node >= 22
- pnpm 10
- Docker (for local Postgres)

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:

- `OPENROUTER_API_KEY` (or an alternate provider key if you switch `AGENT_PROVIDER`)
- `JWT_SECRET` — any long random string
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — seeds the one admin account on first boot; every
  other user is created by an admin afterward (no public register route)

Start Postgres:

```bash
docker compose up -d
```

The schema in `packages/db/schema.sql` applies automatically on first boot of an
empty volume. To re-apply manually:

```bash
pnpm db:schema
```

Run everything:

```bash
pnpm dev
```

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | run all apps in parallel |
| `pnpm build` | build all packages/apps |
| `pnpm typecheck` | typecheck the whole monorepo |
| `pnpm test` | run all tests |

## Before you go public (checklist for forks/clones)

- Never commit `.env` — only `.env.example` is tracked (already enforced by `.gitignore`)
- Rotate/replace `JWT_SECRET` and all provider API keys per deployment, don't reuse
  values across environments
- `ADMIN_PASSWORD` in `.env` is a bootstrap value — change it after first login
