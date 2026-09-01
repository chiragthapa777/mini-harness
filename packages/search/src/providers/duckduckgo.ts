import { searchConfig } from "../config.js";
import { collapse, parse } from "../html.js";
import { guardedFetch } from "../http.js";
import type {
  SafeSearch,
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
} from "../types.js";

/**
 * DuckDuckGo, no API key and no account.
 *
 * There is no free JSON endpoint for real web results — `api.duckduckgo.com`
 * only serves instant answers — so results come from the no-JavaScript HTML
 * front end DDG publishes for old browsers. That is a scrape, and it will break
 * the day DDG changes its markup, which is why parsing is isolated in
 * `parseHtml`/`parseLite` and covered by fixture tests: drift shows up as a
 * failing unit test rather than an agent quietly answering from nothing.
 *
 * The instant-answer endpoint is still worth a call — official, keyless, and
 * often carrying the one-line fact the agent was actually after.
 */

const HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const ANSWER_ENDPOINT = "https://api.duckduckgo.com/";

/** DDG throttles hard on bursts, so requests are serialized and spaced. */
const MIN_INTERVAL_MS = 1200;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("query is empty");

    const config = searchConfig();
    const maxResults = options.maxResults ?? config.maxResults;

    const [results, answer] = await Promise.all([
      this.results(trimmed, {
        region: options.region ?? config.region,
        safeSearch: options.safeSearch ?? config.safeSearch,
        timeoutMs: config.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      // Never let the nice-to-have sink the search.
      instantAnswer(trimmed, config.timeoutMs, options.signal).catch(() => undefined),
    ]);

    return {
      query: trimmed,
      ...(answer ? { answer } : {}),
      results: dedupe(results).slice(0, maxResults),
      provider: this.name,
    };
  }

  private async results(
    query: string,
    opts: { region: string; safeSearch: SafeSearch; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    const body = new URLSearchParams({
      q: query,
      kl: opts.region,
      kp: safeSearchParam(opts.safeSearch),
    }).toString();

    const primary = await throttled(() =>
      guardedFetch(HTML_ENDPOINT, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
          referer: "https://duckduckgo.com/",
        },
        timeoutMs: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );

    const results = parseHtml(primary.body);
    if (results.length) return results;

    // Empty means either a genuine zero-result query or a bot challenge. The
    // lite front end is a different renderer, so it often answers when the
    // main one balks.
    const fallback = await throttled(() =>
      guardedFetch(`${LITE_ENDPOINT}?${new URLSearchParams({ q: query, kl: opts.region })}`, {
        headers: { accept: "text/html", referer: "https://lite.duckduckgo.com/" },
        timeoutMs: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );

    const lite = parseLite(fallback.body);
    if (lite.length) return lite;

    if (isBlocked(primary.body) || isBlocked(fallback.body)) {
      throw new Error(
        "DuckDuckGo returned a bot challenge instead of results — retry in a moment, " +
          "or add a keyed backend to packages/search",
      );
    }
    return [];
  }
}

/** Result blocks in the HTML front end, paired title and snippet per block. */
export function parseHtml(html: string): SearchResult[] {
  const $ = parse(html);
  const results: SearchResult[] = [];

  $("div.result").each((_index, element) => {
    const block = $(element);
    if (block.is(".result--ad, .results_links--ad") || block.find(".badge--ad").length) return;

    const anchor = block.find("a.result__a").first();
    const url = resolveResultUrl(anchor.attr("href"));
    if (!url) return;

    results.push({
      title: collapse(anchor.text()),
      url,
      snippet: collapse(block.find(".result__snippet").first().text()),
    });
  });

  return results;
}

/** The lite front end is a table: links in one row, snippets in the next. */
export function parseLite(html: string): SearchResult[] {
  const $ = parse(html);
  const snippets = $("td.result-snippet")
    .toArray()
    .map((element) => collapse($(element).text()));

  const results: SearchResult[] = [];
  $("a.result-link").each((index, element) => {
    const anchor = $(element);
    const url = resolveResultUrl(anchor.attr("href"));
    if (!url) return;
    results.push({
      title: collapse(anchor.text()),
      url,
      snippet: snippets[index] ?? "",
    });
  });

  return results;
}

/**
 * DDG hands back its own redirector rather than the destination. Unwrap it —
 * the agent needs a URL it can pass straight to `scrape_url`.
 */
export function resolveResultUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;

  const absolute = href.startsWith("//") ? `https:${href}` : href;
  const uddg = /[?&]uddg=([^&]+)/.exec(absolute)?.[1];
  const candidate = uddg ? safeDecode(uddg) : absolute;
  if (!candidate) return undefined;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Anything still on DDG is a redirector or an ad hop, never a destination.
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

async function instantAnswer(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const url = `${ANSWER_ENDPOINT}?${new URLSearchParams({
    q: query,
    format: "json",
    no_html: "1",
    no_redirect: "1",
    skip_disambig: "1",
    t: "mini-agent",
  })}`;

  const response = await throttled(() =>
    guardedFetch(url, {
      headers: { accept: "application/json" },
      timeoutMs,
      ...(signal ? { signal } : {}),
    }),
  );

  const data = JSON.parse(response.body) as {
    Answer?: unknown;
    AbstractText?: unknown;
    Definition?: unknown;
  };

  for (const value of [data.Answer, data.AbstractText, data.Definition]) {
    if (typeof value === "string" && value.trim()) return collapse(value);
  }
  return undefined;
}

function isBlocked(html: string): boolean {
  return /anomaly[-_]modal|bots use DuckDuckGo too|challenge-form/i.test(html);
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(({ url }) => (seen.has(url) ? false : (seen.add(url), true)));
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeSearchParam(level: SafeSearch): string {
  return level === "strict" ? "1" : level === "off" ? "-2" : "-1";
}

/** Serialize requests and keep MIN_INTERVAL_MS between them. */
function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive even when a request rejects.
  queue = run.catch(() => {});
  return run;
}
