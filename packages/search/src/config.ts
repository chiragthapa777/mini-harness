import { getConfig } from "@mini-agent/config";
import type { SafeSearch, SearchProviderName } from "./types.js";

/**
 * Backend choice and retrieval params are config — versioned and released, not
 * inlined at call sites. Mirrors `runConfig()` in `@mini-agent/core`.
 */
export interface SearchConfig {
  provider: SearchProviderName;
  maxResults: number;
  timeoutMs: number;
  region: string;
  safeSearch: SafeSearch;
  scrapeMaxChars: number;
}

export function searchConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  const { search } = getConfig();
  return {
    provider: search.provider,
    maxResults: search.maxResults,
    timeoutMs: search.timeoutMs,
    region: search.region,
    safeSearch: search.safeSearch,
    scrapeMaxChars: search.scrapeMaxChars,
    ...overrides,
  };
}
