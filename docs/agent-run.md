# How an agent run works

Short walk-through of one run, start to finish: how working memory gets built, how the
loop and tool calls work, what gets persisted. Each section links to the exact file for
the full detail — this doc is the map, not the territory.

## 1. Trigger → working memory

`POST /chat` or `POST /chat/stream` (`apps/api/src/routes/chat.routes.ts`) calls
`run()`/`runStream()` (`apps/api/src/services/run.service.ts:27,39`), which first builds
a `WorkingMemory` (`workingMemory()`, `run.service.ts:59`):

```
const [procedural, facts, episodes] = await Promise.all([
  loadProcedural(),        // packages/memory/src/procedural.ts
  searchFacts(userId, prompt),  // packages/memory/src/semantic.ts
  recall(userId, prompt),       // packages/memory/src/episodic.ts
]);
```

Three stores, three retrieval strategies — no ranking logic lives in the loop, only in
these three functions:

| Store | Function | Strategy |
|---|---|---|
| Procedural | `loadProcedural` (`packages/memory/src/procedural.ts:11`) | direct load — every `.md` in `SKILLS_DIR`, no search |
| Semantic | `searchFacts` (`packages/memory/src/semantic.ts:18`) | RAG top-k on `facts.embedding`, falls back to most-recent when no embedding configured |
| Episodic | `recall` (`packages/memory/src/episodic.ts:26`) | union of a recency query (`ORDER BY created_at DESC`) and a relevance query (RAG top-k on `messages.embedding`) |

The result plus the raw user prompt becomes the `WorkingMemory` object
(`packages/core/src/types.ts:21`) passed into the loop — `systemPrompt`, `procedural`,
`semantic`, `episodic`, `history` (episodes reshaped into `Msg[]`), `userPrompt`.

## 2. Assembling the request

`runAgent`/`runAgentStream` (`packages/core/src/loop.ts:19` / `stream.ts:23`) — same
logic, one returns a `Promise`, the other yields `RunEvent`s as they happen.

First call is `buildSystem(wm, tools)` (`loop.ts:116`): stable system prompt, then the
tool catalog, then whichever of the three retrieved sections are non-empty —

```
[wm.systemPrompt, renderToolCatalog(tools), "## How to act\n...", "## What is known\n...", "## What happened before\n..."]
  .filter(Boolean).join("\n\n")
```

That string becomes the one `system` message. History and the user prompt follow it —
`messages = [system, ...wm.history, user]` (`loop.ts:30`). This exact string is what's
now captured verbatim on the `Trace` (`trace.systemPrompt`) and viewable per-run in the
admin Traces tab — see `docs/implementation.md` §2.1.

## 3. The loop and tool calls

No provider-native function calling anywhere in this repo — the model is told (via
`renderToolCatalog`, `packages/core/src/protocol.ts:28`) to answer with fenced
` ```tool_call ` blocks, one JSON object each: `{"tool": "...", "input": {...}}`.

Per iteration (`loop.ts:44`):

1. Guardrail check first — `iteration > maxIterations` → stop `"max_iterations"`;
   running token total over `maxTokensPerRun` → stop `"token_budget"` (`loop.ts:45-52`).
2. `model.invoke(messages)` (or `.stream()`) — one call to `packages/llm`.
3. `parseToolCalls(response.text)` (`protocol.ts:58`) strips fenced blocks out of the
   reply and returns `{ calls, text }`.
4. **No calls** → `text` is the reply, loop stops (`"end_turn"`, or `"length"` if the
   provider's finish reason means truncated — `truncated()`, `loop.ts:138`).
5. **Calls present** → each runs against the matching `AgentTool.run()`
   (`packages/core/src/tools.ts`); a missing tool or a thrown error becomes an error
   result, not an exception — the model always hears back, success or failure
   (`loop.ts:75-88`). Results render back as the *next user turn*
   (`renderToolResults`, `protocol.ts:154`) — tool results are a plain message, not a
   provider tool role. Loop continues to the next iteration.

Every iteration appends one `TraceStep` (`loop.ts:144`) — tool calls, tokens, latency —
so a run with 3 tool round-trips has a 4-entry `steps` array (3 tool iterations + the
final text-only one).

Streaming (`stream.ts`) is the identical sequence, token-by-token: `ToolCallTextFilter`
(`protocol.ts:94`) holds back partial fence markers so a `tool_call` block never leaks
into the user-visible `text_delta` stream, only genuine prose does.

## 4. Persistence

Back in `run.service.ts`: `persist()` (`run.service.ts:79`) saves the user prompt and
(if any) the reply to the episodic store (`saveMessage`,
`packages/memory/src/episodic.ts:58`), then `saveTrace()` (`run.service.ts:91`) inserts
one row into `traces` (`packages/db/schema.sql`) — model, prompt version, the full
system prompt, tokens, latency, stop reason, and the `steps` array as `jsonb`.

Nothing inside the loop survives past this — the harness never keeps state between
runs; everything that must outlive one is in a memory store by the time `run()` returns.

## Further detail

| Topic | File |
|---|---|
| Loop / streaming loop | `packages/core/src/loop.ts`, `packages/core/src/stream.ts` |
| Tool-call wire protocol | `packages/core/src/protocol.ts` |
| Default tools | `packages/core/src/tools.ts` |
| Per-user tools (`remember`, `search_memory`) | `apps/api/src/services/tools.service.ts` |
| Working memory / trace shapes | `packages/core/src/types.ts` |
| Guardrails / system prompt / prompt version | `packages/core/src/config.ts` |
| Procedural / semantic / episodic stores | `packages/memory/src/{procedural,semantic,episodic}.ts` |
| Consolidation (built, not wired — see TODO 7) | `packages/memory/src/consolidate.ts` |
| Run orchestration + persistence | `apps/api/src/services/run.service.ts` |
| Chat transport (`ChatClient`, providers) | `packages/llm/src` |
| Full endpoint/schema/package survey | `docs/implementation.md` |
| Planned system shape | `docs/architecture.md` |
