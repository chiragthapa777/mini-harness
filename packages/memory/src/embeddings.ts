import type { Embeddings } from "@langchain/core/embeddings";

let cached: Embeddings | undefined;
let warned = false;

/** Embedding dimension must match the vector(n) columns in schema.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Embeddings are configured separately from the chat provider, because
 * OpenRouter fronts chat models only — it has no embeddings endpoint. Point
 * EMBEDDINGS_API_KEY (plus EMBEDDINGS_BASE_URL for a non-OpenAI host) at
 * whatever serves them.
 */
export function embeddingsConfigured(): boolean {
  return Boolean(process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY);
}

export async function embeddings(): Promise<Embeddings> {
  if (!cached) {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    const baseURL = process.env.EMBEDDINGS_BASE_URL;
    cached = new OpenAIEmbeddings({
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      dimensions: EMBEDDING_DIMENSIONS,
      apiKey: process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY,
      ...(baseURL ? { configuration: { baseURL } } : {}),
    });
  }
  return cached;
}

/**
 * Returns null when embeddings are not configured. Callers fall back to plain
 * SQL recency: the agent keeps working with less relevant recall rather than
 * failing the run outright.
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
  return (await embeddings()).embedQuery(text);
}
