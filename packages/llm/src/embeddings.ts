import { getConfig } from "@mini-agent/config";
import type OpenAI from "openai";

/** Embedding dimension must match the vector(n) columns in packages/db/schema.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

let cached: OpenAI | undefined;

/**
 * Embeddings are configured separately from the chat provider: the key, the
 * base URL and the model name are their own three settings, and all three have
 * to point at the same place. An empty base URL means OpenAI, so an OpenRouter
 * key with no base URL is sent to api.openai.com and comes back 401 — which
 * reads like a bad key rather than a wrong endpoint.
 *
 * OpenRouter does serve embeddings, under namespaced model names
 * (`openai/text-embedding-3-small`); an earlier version of this comment said
 * otherwise and sent a deployment to the wrong host.
 */
export function embeddingsConfigured(): boolean {
  return Boolean(getConfig().llm.embeddings.apiKey);
}

async function client(): Promise<OpenAI> {
  if (!cached) {
    const { default: OpenAIClient } = await import("openai");
    const { embeddings } = getConfig().llm;
    cached = new OpenAIClient({
      apiKey: embeddings.apiKey,
      ...(embeddings.baseUrl ? { baseURL: embeddings.baseUrl } : {}),
    });
  }
  return cached;
}

/** Batch form. The API preserves input order, so results line up with `texts`. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await (await client()).embeddings.create({
    model: getConfig().llm.embeddings.model,
    dimensions: EMBEDDING_DIMENSIONS,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new Error("embeddings: provider returned no vector");
  return vector;
}
