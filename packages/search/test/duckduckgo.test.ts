import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHtml, parseLite, resolveResultUrl } from "../src/providers/duckduckgo.js";
import { DDG_HTML, DDG_LITE } from "./fixtures/duckduckgo-html.js";

test("parses organic results and skips ads", () => {
  const results = parseHtml(DDG_HTML);

  assert.equal(results.length, 2);
  assert.ok(
    !results.some((result) => /sponsored/i.test(result.title)),
    "ad block leaked into results",
  );
});

test("unwraps the uddg redirector into the real destination", () => {
  const [first] = parseHtml(DDG_HTML);

  assert.equal(first?.url, "https://pnpm.io/installation");
  assert.equal(first?.title, "pnpm installation");
  assert.equal(first?.snippet, "Install pnpm with corepack & friends…");
});

test("keeps hrefs that are already absolute", () => {
  const [, second] = parseHtml(DDG_HTML);

  assert.equal(second?.url, "https://github.com/pnpm/pnpm/releases");
  assert.equal(second?.snippet, "Release notes for every pnpm version.");
});

test("parses the lite front end, pairing links with snippets", () => {
  const results = parseLite(DDG_LITE);

  assert.deepEqual(
    results.map((result) => result.url),
    ["https://nodejs.org/en/download", "https://nodejs.org/api/"],
  );
  assert.equal(results[0]?.title, "Node.js — Download");
  assert.equal(results[1]?.snippet, "The Node.js API reference.");
});

test("markup with no results parses to an empty list rather than throwing", () => {
  assert.deepEqual(parseHtml("<html><body><p>nothing here</p></body></html>"), []);
  assert.deepEqual(parseLite("<html><body><p>nothing here</p></body></html>"), []);
});

test("result URLs that are not usable destinations are dropped", () => {
  assert.equal(resolveResultUrl(undefined), undefined);
  assert.equal(resolveResultUrl("//duckduckgo.com/y.js?ad_provider=bingv7aa"), undefined);
  assert.equal(resolveResultUrl("javascript:alert(1)"), undefined);
  assert.equal(resolveResultUrl("/settings"), undefined);
  assert.equal(resolveResultUrl("//example.com/page"), "https://example.com/page");
});

// Network-gated so CI stays offline: SEARCH_LIVE=1 pnpm --filter @mini-agent/search test
test("live DuckDuckGo search returns usable results", { skip: !process.env.SEARCH_LIVE }, async () => {
  const { search } = await import("../src/client.js");
  const response = await search("pnpm workspace protocol", { maxResults: 3 });

  assert.ok(response.results.length > 0, "no results came back");
  for (const result of response.results) {
    assert.match(result.url, /^https?:\/\//);
    assert.ok(result.title.length > 0, "result without a title");
  }
});
