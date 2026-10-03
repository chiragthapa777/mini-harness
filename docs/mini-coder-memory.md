# mini-coder — memory

Where mini-coder keeps what outlives a turn. Plain files, no database, no vector store.

## Where it lives

A module inside `coder-core`, not a package. Only `Session` uses it.

```
packages/coder-core/src/memory/
  paths.ts        resolves the folders below
  procedural.ts   AGENTS.md files + skill index
  semantic.ts     MEMORY.md read / remember / size cap
  episodic.ts     session log, session index, recall
  index.ts        the Memory interface Session depends on
```

## On disk

Everything the harness writes lives outside the project, so it is hidden from the user's repo and never committed:

```
~/.mini-coder/
  AGENTS.md                         personal rules, written by the user
  MEMORY.md                         facts about the user, all projects
  skills/<name>/SKILL.md            personal skills
  projects/<project-slug>/          slug = project realpath, "/" → "-"
    MEMORY.md                       facts about this project
    sessions/<session-id>.jsonl     full log: events + LLM history
    sessions/index.jsonl            one line per session: id, date, title, summary

<project>/
  AGENTS.md                         project rules, human-owned, committed
  .mini-coder/skills/<name>/SKILL.md project skills
```

The path guard denies `~/.mini-coder/` to the file tools, so only the memory module writes there.

## The three kinds

| Kind | Needed? | Stored as | Gets into context |
|---|---|---|---|
| Procedural | yes | `AGENTS.md` (user + project), `SKILL.md` | `AGENTS.md` in full; skills as a name + description index, full file read on demand |
| Semantic | yes, small | `MEMORY.md` (user + project), one fact per line | in full, in the system prompt |
| Episodic | yes | session JSONL + `index.jsonl` | not by default; the `recall` tool searches it |

**Procedural.** Loaded directly, with no search. `AGENTS.md` stays human-owned; the agent never edits it.

**Semantic.** The `remember(fact, scope)` tool appends one line to the user's or the project's `MEMORY.md`. It is a write, so it goes through the permission gate (default: ask). That matters because a remembered line reaches every future session. A project's facts fit in the prompt, so there is no retrieval step. Each file is capped at about 200 lines. Past that, a cheap model call at session end merges duplicates and drops stale lines.

**Episodic.** The session log is written anyway, for resume and as the trace. At session end, one cheap model call writes a title and a 3-line summary to `index.jsonl`. `recall(query)` runs a text search over the index, then the matching logs. A system-prompt line tells the model it exists. Nothing is preloaded, so the prompt stays small and cache-stable.

## Working memory

This is the context sent on each call: system prompt plus history. It is built by the context builder, not stored. Compaction rewrites the history; the session log keeps everything, so resume and recall still see the full session.

## Interface

```ts
interface Memory {
  procedural(): Promise<{ agents: string[]; skills: SkillIndexEntry[] }>;
  facts(): Promise<string>;
  remember(fact: string, scope: "user" | "project"): Promise<void>;
  append(entry: SessionEntry): Promise<void>;     // session log
  load(sessionId: string): Promise<SessionEntry[]>;
  endSession(summary: SessionSummary): Promise<void>;
  recall(query: string): Promise<RecallHit[]>;
}
```

## Not now

Embeddings, vector search, preloading past sessions into the prompt.
