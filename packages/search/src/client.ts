import { searchConfig } from "./config.js";
import { DuckDuckGoProvider } from "./providers/duckduckgo.js";
import type { SearchOptions, SearchProvider, SearchProviderName, SearchResponse } from "./types.js";

/**
 * The registry is the whole extension point. A new backend is one file under
 * `providers/` implementing `SearchProvider`, one entry here, and one name in
 * `SearchProviderName` — no consumer changes, because the tool in
 * `@mini-agent/core` only ever sees `search()`.
 */
const PROVIDERS: Record<SearchProviderName, () => SearchProvider> = {
  duckduckgo: () => new DuckDuckGoProvider(),
};

const instances = new Map<string, SearchProvider>();

export function searchClient(name?: SearchProviderName): SearchProvider {
  const provider = name ?? searchConfig().provider;
  const factory = PROVIDERS[provider];
  if (!factory) {
    throw new Error(
      `unknown search provider: ${provider} (available: ${Object.keys(PROVIDERS).join(", ")})`,
    );
  }

  let instance = instances.get(provider);
  if (!instance) {
    instance = factory();
    instances.set(provider, instance);
  }
  return instance;
}

/** What callers use. Resolves the configured backend on every call. */
export function search(query: string, options?: SearchOptions): Promise<SearchResponse> {
  return searchClient().search(query, options);
}
