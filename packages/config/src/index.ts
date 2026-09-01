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
  PROMPT_VERSION: str("1"),

  RAG_TOP_K: numeric(5),
  EPISODIC_RECENT_LIMIT: numeric(10),
  CONSOLIDATE_AFTER_N_MESSAGES: numeric(20),
  SKILLS_DIR: str("skills"),

  SEARCH_PROVIDER: z.enum(SEARCH_PROVIDERS).catch("duckduckgo"),
  SEARCH_MAX_RESULTS: numeric(5),
  SEARCH_TIMEOUT_MS: numeric(10_000),
  SEARCH_REGION: str("us-en"),
  SEARCH_SAFE_SEARCH: z.enum(SAFE_SEARCH_LEVELS).catch("moderate"),
  SCRAPE_MAX_CHARS: numeric(8000),

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
    consolidateAfterNMessages: number;
    skillsDir: string;
  };
  search: {
    provider: SearchProviderName;
    maxResults: number;
    timeoutMs: number;
    region: string;
    safeSearch: SafeSearch;
    scrapeMaxChars: number;
  };
  db: { url?: string };
  api: { port: number; jwtSecret?: string; jwtExpiresIn: string };
  web: { apiUrl: string };
  /** Seeds one admin account at startup so the first user never needs a public register route. */
  bootstrapAdmin: { email?: string; password?: string };
  /** Lockout policy after repeated failed logins. */
  auth: { maxLoginAttempts: number; lockoutMinutes: number };
  /** Background job runner. `enabled: false` keeps every producer inline. */
  jobs: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    staleAfterMs: number;
  };
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
      consolidateAfterNMessages: env.CONSOLIDATE_AFTER_N_MESSAGES,
      skillsDir: env.SKILLS_DIR,
    },
    search: {
      provider: env.SEARCH_PROVIDER,
      maxResults: env.SEARCH_MAX_RESULTS,
      timeoutMs: env.SEARCH_TIMEOUT_MS,
      region: env.SEARCH_REGION,
      safeSearch: env.SEARCH_SAFE_SEARCH,
      scrapeMaxChars: env.SCRAPE_MAX_CHARS,
    },
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
    },
  };
}
