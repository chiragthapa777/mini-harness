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

