# mini-coder — memory

Where mini-coder keeps what outlives a turn. Plain files, no database, no vector store.

## Where it lives

One file inside `coder-core`, `src/memory.ts`, not a package. `loadMemory(home, root)` reads everything once at session start and returns the text for the system prompt plus the `skill`, `remember` and `recall` tools. The session log is `src/sessions.ts`.

## On disk

Everything the harness writes lives outside the project, so it is hidden from the user's repo and never committed:

```
~/.mini-coder/
  AGENTS.md                         personal rules, written by the user
  MEMORY.md                         facts about the user, all projects
  skills/<name>/SKILL.md            personal skills
  projects/<project-slug>/          slug = project realpath, "/" → "-"
    MEMORY.md                       facts about this project
    sessions/<time>-<id>.jsonl      one line per turn: what was shown + what the model was told

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
| Episodic | yes | session JSONL | not by default; the `recall` tool searches it |

**Procedural.** Loaded directly, with no search. `AGENTS.md` stays human-owned; the agent never edits it.

**Semantic.** The `remember(fact, scope)` tool appends one line to the user's or the project's `MEMORY.md`. It is a write, so it goes through the permission gate (default: ask; `accept-edits` lets it through). That matters because a remembered line reaches every future session. A project's facts fit in the prompt, so there is no retrieval step. A remembered fact reaches the prompt from the next session on. Planned, not built: a cap at about 200 lines, past which a cheap model call at session end merges duplicates and drops stale lines. For now a file only grows, and its first 20,000 characters are loaded.

**Episodic.** The session log is written anyway, for resume and as the trace: one line when a turn ends, holding the messages a replay needs (the user's text, the reply text joined up, tool cards, how the turn ended) and the entries the turn added to the model's history. `/clear` and a compaction write a line marked `reset`, after which the history starts over. `recall(query)` reads the project's logs, newest first, and returns up to 10 turns that contain every word of the query. Nothing is preloaded, so the prompt stays small and cache-stable.

Not built: a title and summary per session in an index, written by a cheap model call at session end. A turn that the process dies in the middle of is not logged.

## Working memory

This is the context sent on each call: system prompt plus history. It is built by the context builder, not stored. Compaction replaces the history with the model's own summary of it: before a turn that starts with more than 120,000 tokens of context, or on `/compact`. It does not happen in the middle of a turn. The session log keeps every turn, so recall still sees the full session; a resume shows the full transcript but gives the model the summary.

## Not now

Embeddings, vector search, preloading past sessions into the prompt.
