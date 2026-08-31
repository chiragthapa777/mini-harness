# Mini-Agent Architecture

Three layers:

- **Gateway** — how a user reaches the agent: TUI, web app, WhatsApp/Telegram chat bot.
- **AI Harness engineering** — runtime that assembles context, runs the agentic loop, calls tools, persists memory.
- **LLM Ops** — offline loop that traces, evaluates, diagnoses, gates, and releases fixes back into the harness.

---

## 1. Whole System

![Mini-agent architecture: gateway, AI harness (agent run, agentic loop, memory) and LLM Ops](./arch.png)

User enters through the gateway. Inside the harness the run flows left-to-right
(inputs -> working memory -> LLM -> reply), the agentic loop sits on top of it, and the
memory layer sits underneath with its databases and the consolidation path at the bottom.
Every reply also leaves the harness as a trace into LLM Ops, which feeds fixes back in.

---

## 2. Gateway

The only entry point. Same agent behind every surface:

- TUI
- Web app
- WhatsApp / Telegram chat bot

The gateway hands the user's message to the agent run as the **User Prompt**.

---

## 3. Harness

Everything inside the **AI Agent Run** box is **ephemeral** — it lives for one run and is discarded. Anything that must survive has to be written to a memory store.

### 3.1 Inputs -> Working Memory

Three sources assembled into **Working Memory / Context RAM** — the prompt actually sent to the model:

| Input | Source | Notes |
|---|---|---|
| User Prompt | Gateway | Current turn. |
| Current Chat History | Run state | Messages so far this conversation. |
| System Prompt | Config | Versioned artifact; updated by the Ops release step. |

Working memory is also enriched from the three long-term stores (§3.3).

### 3.2 The Agentic Loop

```mermaid
flowchart TB
  WM["Working Memory<br/>or Context RAM"]

  subgraph LOOP["Agentic Loop"]
    direction LR
    LLM(["LLM — chat agent<br/>claude / gpt / gemini"])
    TOOLS["Tool access, via function call / MCP<br/>• web search tool<br/>• fetch information from APIs<br/>• access file system"]
    LLM -->|tool calls| TOOLS
    TOOLS -->|tool response| LLM
  end

  REPLY["Reply"]

  WM --> LLM
  LLM -->|End Loop Guardrails| REPLY
```

- **LLM — chat agent** — Claude, GPT, or Gemini class model. Each iteration: call a tool, or answer.
- **Tool access** — exposed via function calling or MCP: web search, fetching information from APIs, file system access. Tool responses re-enter the loop as new context.
- **End Loop Guardrails** — termination conditions: max iterations, token/cost budget, output validation, safety checks. Without them the loop can spin forever.
- **Reply** — goes to the user, **and** is saved to the episodic database, **and** is stored as a trace in LLM Ops.

### 3.3 Memory Types

Three stores, each with its own retrieval mechanism.

```mermaid
flowchart BT
  subgraph MEM["LONG-TERM MEMORY"]
    direction LR
    PM["Procedural Memory<br/>(files, txt, md)<br/>• tells how to act (workflow)<br/>• instruction file (skills.md)<br/>• rules and guardrails"]
    SM["Semantic Memory<br/>(vector store)<br/>• durable facts<br/>• domain rules<br/>• org data dictionary"]
    EM["Episodic Memory<br/>(vector store and db)<br/>• past chat history<br/>• dated events"]
  end

  WM["Working Memory<br/>or Context RAM"]

  PM -->|Skills.md| WM
  SM -->|RAG top-k| WM
  EM -->|"RAG for relevance +<br/>SQL for recent data"| WM
```

Episodic is the only one needing **both** a vector store and a DB: relevance alone is not enough when "what did we discuss last Tuesday" is a recency question — that part is a SQL query.

### 3.4 Memory Consolidation

Episodic memory grows every run; semantic memory should not.

```mermaid
flowchart TB
  REPLY["Reply"]

  subgraph MEM["LONG-TERM MEMORY"]
    direction TB
    EDB[("Database<br/>episodic")]
    EM["Episodic Memory"]
    NGATE{"Consolidate after<br/>N messages"}
    SUMM(["Summarizer agent"])
    SDB[("Database<br/>semantic")]
    SM["Semantic Memory"]

    EDB --> EM
    EDB --> NGATE
    NGATE --> SUMM
    SUMM -->|distilled facts| SDB
    SDB --> SM
  end

  REPLY -->|save message| EDB
```

1. Every reply is saved to the episodic database.
2. Gate batches the work — consolidate only after **N messages**, not per turn. Keeps cost bounded.
3. Summarizer agent compresses the raw messages; this is compression, not reasoning, so a cheaper model fits.
4. **Distilled facts** are written to the semantic database and become semantic memory.

Net: episodic = append-only log. Semantic = curated, deduplicated derivative.

---

## 4. LLM Ops

Fed by every run's reply.

```mermaid
flowchart TB
  subgraph OPS["LLM Ops"]
    direction TB
    TRACE["Store 1 trace per run"]
    EVAL["EVAL (was it correct)<br/>• llm as a judge<br/>• deterministic evals"]
    OBS["OBSERVE (was it healthy)<br/>• token track<br/>• latency<br/>• errors"]
    DIAG["DIAGNOSE<br/>what and when it went wrong"]
    GATE{"Gate"}
    REL["RELEASE<br/>• ship the fix code and config<br/>• model configs and tool change<br/>• RAG config changes"]

    TRACE --> EVAL
    TRACE --> OBS
    EVAL --> DIAG
    OBS --> DIAG
    DIAG --> GATE
    GATE -->|Failed| TRACE
    GATE -->|Passed| REL
  end

  REPLY["Reply"] --> TRACE
  REL --> RUN["AI Agent Run"]
```

### 4.1 Trace

**Store one trace per run.** The trace is the unit of analysis: prompt, retrieved context, each loop iteration, tool calls, final reply.

### 4.2 Two Independent Questions

| | Question | Method | Signal |
|---|---|---|---|
| **EVAL** | Was it correct? | LLM-as-a-judge + deterministic evals | Quality scores |
| **OBSERVE** | Was it healthy? | Instrumentation | Token track, latency, errors |

Independent failure modes. A run can be fast, cheap, error-free — and wrong. Or correct and unaffordable.

Deterministic evals sit next to the judge on purpose: exact-match, schema, and regression checks are cheap and stable, and the judge covers what they cannot express.

### 4.3 Diagnose -> Gate

- **DIAGNOSE** — what and when it went wrong. Localize to a stage: retrieval, prompt, tool, model config.
- **Gate** — decision on eval result.
  - **Failed** -> back to trace: fix, re-run, re-trace, re-eval.
  - **Passed** -> Release.

### 4.4 Release

What ships:

- fix code and config
- model configs and tool changes
- RAG config changes

Released changes feed back into the agent run. Closes the outer loop.

---

## 5. Three Loops, Three Timescales

| | Inner | Consolidation | Outer |
|---|---|---|---|
| Where | Inside a run | Across N messages | Across runs |
| Iterates on | Tool calls | Episodic -> semantic | Code, prompt, config |
| Terminated by | End loop guardrails | N-message gate | Gate (passed) |
| Timescale | Seconds | Hours | Hours to days |
| State | Ephemeral | Durable | Versioned + released |
