import { EMBEDDING_DIMENSIONS, embedQuery, embeddingsConfigured } from "@mini-agent/llm";

/** Embedding dimension must match the vector(n) columns in schema.sql. */
export { EMBEDDING_DIMENSIONS, embeddingsConfigured };

let warned = false;

/**
 * Returns null when embeddings are not configured. Callers fall back to plain
 * SQL recency: the agent keeps working with less relevant recall rather than
 * failing the run outright.
 *
 * The transport lives in `@mini-agent/llm`; this wrapper owns only that policy.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) {
    if (!warned) {
      warned = true;
      console.warn(
        "[memory] no embeddings key set — semantic search is off, " +
          "memory falls back to recency. Set EMBEDDINGS_API_KEY to enable RAG.",
      );
    }
    return null;
  }
  return embedQuery(text);
}
