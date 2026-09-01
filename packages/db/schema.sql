-- Postgres is both the SQL store and the vector store.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------- auth

CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE,
  password_hash         text NOT NULL,
  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Covers databases created before these columns existed; a fresh CREATE TABLE
-- above already has them, so these are no-ops there.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- ---------------------------------------------------------------- episodic
-- Append-only log of what happened. Retrieval is RAG for relevance plus
-- SQL for recency, which is why this table carries both an embedding and a
-- real timestamp index.

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          text NOT NULL,
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content          jsonb NOT NULL,
  embedding        vector(1536),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- set once the message has been folded into semantic memory
  consolidated_at  timestamptz
);

CREATE INDEX IF NOT EXISTS messages_recency_idx
  ON messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_unconsolidated_idx
  ON messages (user_id) WHERE consolidated_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops);

-- dated events, separate from chat turns
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  summary     text NOT NULL,
  occurred_at timestamptz NOT NULL,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_recency_idx ON events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_embedding_idx
  ON events USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- semantic
-- Curated, deduplicated derivative of the episodic log. Written by the
-- summarizer agent, never by the run loop.

CREATE TABLE IF NOT EXISTS facts (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('fact', 'profile', 'domain_rule', 'data_dictionary')),
  content     text NOT NULL,
  source      text,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facts_user_idx ON facts (user_id, kind);
CREATE INDEX IF NOT EXISTS facts_embedding_idx
  ON facts USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------------ traces
-- One trace per run. Everything LLM Ops needs to answer "was it correct"
-- and "was it healthy" for a single run.

CREATE TABLE IF NOT EXISTS traces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id        text NOT NULL,
  model          text NOT NULL,
  prompt_version text,
  system_prompt  text,
  iterations     int NOT NULL DEFAULT 0,
  input_tokens   int NOT NULL DEFAULT 0,
  output_tokens  int NOT NULL DEFAULT 0,
  latency_ms     int,
  stop_reason    text,
  error          text,
  steps          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS traces_recency_idx ON traces (created_at DESC);
CREATE INDEX IF NOT EXISTS traces_errors_idx ON traces (created_at DESC) WHERE error IS NOT NULL;

ALTER TABLE traces ADD COLUMN IF NOT EXISTS system_prompt text;

-- -------------------------------------------------------------------- jobs
-- Work that runs outside a request/response cycle. This one table is both the
-- queue and the audit log: the status columns are the tracking, so a finished
-- job is not deleted, it is a row with a terminal status the admin panel reads.
--
-- Claiming uses `FOR UPDATE SKIP LOCKED`, which is why no separate lock table
-- or external broker is needed — Postgres is the queue.

CREATE TABLE IF NOT EXISTS jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  -- null for maintenance work that belongs to no single user (sweeps)
  user_id       text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  last_error    text,
  -- collapses duplicate work: only one live job may hold a given key
  dedupe_key    text,
  result        jsonb,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The claim query's index: due, queued, oldest first.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (scheduled_for, id) WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS jobs_recency_idx ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, type);

-- Enqueueing the same key twice while the first is still live is a no-op
-- (`ON CONFLICT DO NOTHING`), so a sweep can run every tick without piling up.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Recovering a stuck job needs the start time of everything still running.
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (started_at) WHERE status = 'running';

-- --------------------------------------------------------------- schedules
-- Cron, in the app rather than in the database: one table for both the
-- maintenance schedules defined in config (`kind = 'system'`, identified by a
-- stable `key`) and the ones a user creates (`kind = 'user'`, a prompt plus a
-- cadence). The scheduler tick turns a due row into a `jobs` row and nothing
-- else — firing and running stay separate concerns.

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL DEFAULT 'user' CHECK (kind IN ('system', 'user')),
  -- stable identity for a config-defined schedule; null for user schedules
  key          text UNIQUE,
  user_id      text,
  name         text NOT NULL,
  job_type     text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- what a user schedule sends the agent; null for maintenance schedules
  prompt       text,
  cron         text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  last_run_at  timestamptz,
  -- the job this schedule fired last, so a slow run is not fired again on top of itself
  last_job_id  bigint REFERENCES jobs(id) ON DELETE SET NULL,
  next_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS scheduled_jobs_user_idx ON scheduled_jobs (user_id, created_at DESC);

