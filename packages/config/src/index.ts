import { z } from "zod";

/**
 * Every environment variable the project reads, in one place. No other
 * package touches `process.env` directly — this is the only file that does,
 * so a var can be renamed, defaulted, or validated in one spot instead of N.
 *
 * `getConfig()` re-parses `process.env` on every call rather than caching at
 * import time: tests stub individual keys per-case, and a long-lived process
 * (the API server) should never need a restart to pick up a changed var.
 */

const AGENT_PROVIDERS = ["openrouter", "anthropic", "openai", "google"] as const;
const SEARCH_PROVIDERS = ["duckduckgo"] as const;
const SAFE_SEARCH_LEVELS = ["off", "moderate", "strict"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];
export type SafeSearch = (typeof SAFE_SEARCH_LEVELS)[number];

/** Falls back on anything that isn't a finite positive number — unset, empty, or garbage. */
function numeric(fallback: number) {
  return z.preprocess((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }, z.number());
}

function str(fallback: string) {
  return z.preprocess(
    (value) => (typeof value === "string" && value !== "" ? value : fallback),
    z.string(),
  );
}

/** Boolean env var that defaults to on: only the literal "false" turns it off. */
const boolTrue = z.preprocess((value) => value !== "false", z.boolean());

const optionalStr = z.preprocess(
  (value) => (typeof value === "string" && value !== "" ? value : undefined),
  z.string().optional(),
);

/**
 * A JSON blob in an env var. Anything unparseable falls back to `{}` and is
 * warned about: one malformed MCP entry should cost you that server, not the
 * ability to start the process.
 */
const jsonObject = z.preprocess((value) => {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[config] MCP_SERVERS is not valid JSON — no MCP servers will be loaded");
    return {};
  }
}, z.record(z.string(), z.unknown()));

const schema = z.object({
  OPENROUTER_API_KEY: optionalStr,
  OPENROUTER_BASE_URL: str("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: str(""),
  OPENROUTER_APP_NAME: str("mini-agent"),
  OPENAI_API_KEY: optionalStr,
  ANTHROPIC_API_KEY: optionalStr,
  GOOGLE_API_KEY: optionalStr,
  GEMINI_API_KEY: optionalStr,
  AGENT_REASONING: z.preprocess((value) => value !== "false", z.boolean()),

  EMBEDDINGS_API_KEY: optionalStr,
  EMBEDDINGS_BASE_URL: optionalStr,
  EMBEDDING_MODEL: str("text-embedding-3-small"),

  AGENT_PROVIDER: z.enum(AGENT_PROVIDERS).catch("openrouter"),
  AGENT_MODEL: str("z-ai/glm-5.3-flash"),
  AGENT_MAX_TOKENS: numeric(16000),
  AGENT_MAX_ITERATIONS: numeric(8),
  AGENT_MAX_TOKENS_PER_RUN: numeric(100_000),
  PROMPT_VERSION: str("3"),

  RAG_TOP_K: numeric(5),
  EPISODIC_RECENT_LIMIT: numeric(10),
  // Turns of the *current* conversation replayed verbatim as chat history.
  // Anything older is carried by that conversation's rolling summary.
  HISTORY_LIMIT: numeric(20),
  CONSOLIDATE_AFTER_N_MESSAGES: numeric(20),
  SKILLS_DIR: str("skills"),

  // Memory's own model calls — summaries, fact extraction, fact merging. A
  // cheap model is enough; empty means "whatever the agent is using".
  SUMMARY_PROVIDER: optionalStr,
  SUMMARY_MODEL: optionalStr,
  SUMMARY_MAX_TOKENS: numeric(1_000),
  // Hard cap on a conversation summary. It is a retrieval unit, not an archive.
  SUMMARY_MAX_WORDS: numeric(200),
  // How many of a conversation's messages one summarize pass reads.
  SUMMARY_MAX_MESSAGES: numeric(120),

  // Uploaded documents. A chunk is what comes back from a search and lands in
  // the prompt, so it has to read sensibly on its own.
  UPLOAD_CHUNK_CHARS: numeric(1_000),
  UPLOAD_CHUNK_OVERLAP: numeric(150),
  // Ceiling on one uploaded file, in characters.
  UPLOAD_MAX_CHARS: numeric(400_000),

  // Fact consolidation. Distance is pgvector cosine distance (0 = identical),
  // so a *smaller* threshold merges less. 0.45 was measured, not guessed: with
  // text-embedding-3-small, paraphrases of one fact land at 0.18-0.39 while
  // unrelated facts sit at 0.69+, so this falls in the gap between them.
  FACT_DEDUPE_DISTANCE: numeric(0.45),
  // Above this many active facts, a user is worth a dedup pass.
  FACT_DEDUPE_MIN_FACTS: numeric(10),
  // Ceiling on active facts per user; the least recently updated are archived
  // past it, so top-k quality does not decay as the table grows.
  FACT_MAX_PER_USER: numeric(500),

  SEARCH_PROVIDER: z.enum(SEARCH_PROVIDERS).catch("duckduckgo"),
  SEARCH_MAX_RESULTS: numeric(5),
  SEARCH_TIMEOUT_MS: numeric(10_000),
  SEARCH_REGION: str("us-en"),
  SEARCH_SAFE_SEARCH: z.enum(SAFE_SEARCH_LEVELS).catch("moderate"),
  SCRAPE_MAX_CHARS: numeric(8000),

  // MCP servers to connect to, as JSON:
  //   {"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}
  MCP_SERVERS: jsonObject,

  DATABASE_URL: optionalStr,

  PORT: numeric(3001),
  API_URL: str("http://localhost:3001"),

  JWT_SECRET: optionalStr,
  JWT_EXPIRES_IN: str("7d"),

  ADMIN_EMAIL: optionalStr,
  ADMIN_PASSWORD: optionalStr,

  LOGIN_MAX_ATTEMPTS: numeric(5),
  LOGIN_LOCKOUT_MINUTES: numeric(15),

  // Background work. `JOBS_ENABLED=false` makes producers do their work inline
  // instead of enqueueing it, so the API stays fully functional with no worker.
  JOBS_ENABLED: boolTrue,
  JOB_POLL_INTERVAL_MS: numeric(2_000),
  JOB_BATCH_SIZE: numeric(5),
  JOB_MAX_ATTEMPTS: numeric(3),
  JOB_RETRY_BASE_MS: numeric(30_000),
  JOB_RETRY_MAX_MS: numeric(900_000),
  JOB_STALE_AFTER_MS: numeric(600_000),

  // Scheduling. The maintenance cadences below are config, not constants in
  // the worker: a schedule is released like a prompt is.
  SCHEDULER_ENABLED: boolTrue,
  SCHEDULER_TICK_MS: numeric(30_000),
  SUMMARIZE_CRON: str("*/5 * * * *"),
  CONSOLIDATE_CRON: str("*/15 * * * *"),
  DEDUPE_FACTS_CRON: str("30 3 * * *"),
  EMBED_BACKFILL_CRON: str("*/10 * * * *"),
});

export interface Config {
  llm: {
    openrouter: { apiKey?: string; baseUrl: string; siteUrl: string; appName: string };
    openai: { apiKey?: string };
    anthropic: { apiKey?: string };
    google: { apiKey?: string };
    embeddings: { apiKey?: string; baseUrl?: string; model: string };
    reasoningEnabled: boolean;
  };
  agent: {
    provider: AgentProvider;
    model: string;
    maxTokens: number;
    maxIterations: number;
    maxTokensPerRun: number;
    promptVersion: string;
  };
  memory: {
    ragTopK: number;
    episodicRecentLimit: number;
    historyLimit: number;
    consolidateAfterNMessages: number;
    skillsDir: string;
    /** The model memory uses for its own summarizing. Defaults to the agent's. */
    summaryProvider: AgentProvider;
    summaryModel: string;
    summaryMaxTokens: number;
    summaryMaxWords: number;
    summaryMaxMessages: number;
    uploadChunkChars: number;
    uploadChunkOverlap: number;
    uploadMaxChars: number;
    factDedupeDistance: number;
    factDedupeMinFacts: number;
    factMaxPerUser: number;
  };
  search: {
    provider: SearchProviderName;
    maxResults: number;
    timeoutMs: number;
    region: string;
    safeSearch: SafeSearch;
    scrapeMaxChars: number;
  };
  /**
   * MCP servers, keyed by the name their tools are namespaced under. Values are
   * `McpServerConfig` from `@mini-agent/mcp` — kept loose here so config keeps
   * depending on nothing.
   */
  mcp: { servers: Record<string, McpServer> };
  db: { url?: string };
  api: { port: number; jwtSecret?: string; jwtExpiresIn: string };
  web: { apiUrl: string };
  /** Seeds one admin account at startup so the first user never needs a public register route. */
  bootstrapAdmin: { email?: string; password?: string };
  /** Lockout policy after repeated failed logins. */
  auth: { maxLoginAttempts: number; lockoutMinutes: number };
  /**
   * Maintenance schedules, seeded into `scheduled_jobs` by the scheduler and
   * pausable from the admin panel afterwards.
   */
  schedules: SystemSchedule[];
  /** Background job runner. `enabled: false` keeps every producer inline. */
  jobs: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    staleAfterMs: number;
    schedulerEnabled: boolean;
    schedulerTickMs: number;
  };
}

/** How to start one MCP server. It is a child process, so this is a command line. */
export interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** A schedule the system owns. `key` is its stable identity across restarts. */
export interface SystemSchedule {
  key: string;
  name: string;
  /** A `JobType` from `@mini-agent/jobs` — kept as a string so config depends on nothing. */
  jobType: string;
  cron: string;
}

export function getConfig(): Config {
  const env = schema.parse(process.env);

  return {
    llm: {
      openrouter: {
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        siteUrl: env.OPENROUTER_SITE_URL,
        appName: env.OPENROUTER_APP_NAME,
      },
      openai: { apiKey: env.OPENAI_API_KEY },
      anthropic: { apiKey: env.ANTHROPIC_API_KEY },
      google: { apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY },
      embeddings: {
        apiKey: env.EMBEDDINGS_API_KEY ?? env.OPENAI_API_KEY,
        baseUrl: env.EMBEDDINGS_BASE_URL,
        model: env.EMBEDDING_MODEL,
      },
      reasoningEnabled: env.AGENT_REASONING,
    },
    agent: {
      provider: env.AGENT_PROVIDER,
      model: env.AGENT_MODEL,
      maxTokens: env.AGENT_MAX_TOKENS,
      maxIterations: env.AGENT_MAX_ITERATIONS,
      maxTokensPerRun: env.AGENT_MAX_TOKENS_PER_RUN,
      promptVersion: env.PROMPT_VERSION,
    },
    memory: {
      ragTopK: env.RAG_TOP_K,
      episodicRecentLimit: env.EPISODIC_RECENT_LIMIT,
      historyLimit: env.HISTORY_LIMIT,
      consolidateAfterNMessages: env.CONSOLIDATE_AFTER_N_MESSAGES,
      skillsDir: env.SKILLS_DIR,
      summaryProvider: AGENT_PROVIDERS.includes(env.SUMMARY_PROVIDER as AgentProvider)
        ? (env.SUMMARY_PROVIDER as AgentProvider)
        : env.AGENT_PROVIDER,
      summaryModel: env.SUMMARY_MODEL ?? env.AGENT_MODEL,
      summaryMaxTokens: env.SUMMARY_MAX_TOKENS,
      summaryMaxWords: env.SUMMARY_MAX_WORDS,
      summaryMaxMessages: env.SUMMARY_MAX_MESSAGES,
      uploadChunkChars: env.UPLOAD_CHUNK_CHARS,
      uploadChunkOverlap: env.UPLOAD_CHUNK_OVERLAP,
      uploadMaxChars: env.UPLOAD_MAX_CHARS,
      factDedupeDistance: env.FACT_DEDUPE_DISTANCE,
      factDedupeMinFacts: env.FACT_DEDUPE_MIN_FACTS,
      factMaxPerUser: env.FACT_MAX_PER_USER,
    },
    search: {
      provider: env.SEARCH_PROVIDER,
      maxResults: env.SEARCH_MAX_RESULTS,
      timeoutMs: env.SEARCH_TIMEOUT_MS,
      region: env.SEARCH_REGION,
      safeSearch: env.SEARCH_SAFE_SEARCH,
      scrapeMaxChars: env.SCRAPE_MAX_CHARS,
    },
    mcp: { servers: env.MCP_SERVERS as Record<string, McpServer> },
    db: { url: env.DATABASE_URL },
    api: { port: env.PORT, jwtSecret: env.JWT_SECRET, jwtExpiresIn: env.JWT_EXPIRES_IN },
    web: { apiUrl: env.API_URL },
    bootstrapAdmin: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    auth: { maxLoginAttempts: env.LOGIN_MAX_ATTEMPTS, lockoutMinutes: env.LOGIN_LOCKOUT_MINUTES },
    jobs: {
      enabled: env.JOBS_ENABLED,
      pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
      batchSize: env.JOB_BATCH_SIZE,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      retryBaseMs: env.JOB_RETRY_BASE_MS,
      retryMaxMs: env.JOB_RETRY_MAX_MS,
      staleAfterMs: env.JOB_STALE_AFTER_MS,
      schedulerEnabled: env.SCHEDULER_ENABLED,
      schedulerTickMs: env.SCHEDULER_TICK_MS,
    },
    schedules: [
      {
        key: "summarize-conversations",
        name: "Summarize conversations with new messages",
        jobType: "summarize_sweep",
        cron: env.SUMMARIZE_CRON,
      },
      {
        key: "consolidate-memory",
        name: "Consolidate episodic memory into facts",
        jobType: "consolidate_sweep",
        cron: env.CONSOLIDATE_CRON,
      },
      {
        key: "dedupe-facts",
        name: "Merge near-duplicate facts",
        jobType: "dedupe_sweep",
        cron: env.DEDUPE_FACTS_CRON,
      },
      {
        key: "embed-backfill",
        name: "Backfill rows whose embedding never landed",
        jobType: "embed_backfill",
        cron: env.EMBED_BACKFILL_CRON,
      },
    ],
  };
}
