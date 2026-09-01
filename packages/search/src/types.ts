/**
 * Web access, and nothing more.
 *
 * This package is a transport in the same sense as `@mini-agent/llm`: it knows
 * how to reach a search backend and how to pull readable text off a page. It
 * does not know what a tool is, what the loop is, or who the user is — the
 * `AgentTool` wrappers live in `@mini-agent/core`, so the dependency only ever
 * runs core -> search.
 *
 * Only DuckDuckGo is implemented today. Every backend goes behind
 * `SearchProvider`, so adding Tavily, Serper, or a self-hosted SearXNG later is
 * one new file under `providers/` plus one line in the registry in `client.ts`.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  /** Instant answer / abstract, when the backend has one. */
  answer?: string;
  results: SearchResult[];
  /** Which backend produced this, for the trace. */
  provider: string;
}

export interface SearchOptions {
  maxResults?: number;
  /** Region hint, e.g. "us-en". DuckDuckGo calls this `kl`. */
  region?: string;
  safeSearch?: SafeSearch;
  signal?: AbortSignal;
}

export type SafeSearch = "off" | "moderate" | "strict";

/** Implement this and register it in `client.ts` to add a backend. */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

/** Widen as backends land. */
export type SearchProviderName = "duckduckgo";

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
}

export interface ScrapeOptions {
  maxChars?: number;
  signal?: AbortSignal;
}
