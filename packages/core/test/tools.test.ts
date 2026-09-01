import assert from "node:assert/strict";
import { test } from "node:test";
import { calculator, clock, defaultTools, fetchUrl, scrapeUrl, webSearch } from "../src/tools.js";

test("clock returns a parseable timestamp", async () => {
  const output = await clock.run({ timezone: "UTC" });
  assert.ok(!Number.isNaN(Date.parse(output)), `unparseable: ${output}`);
});

test("clock works without a timezone", async () => {
  assert.ok((await clock.run({})).length > 0);
});

test("clock rejects a bad timezone through its schema at the call site", () => {
  assert.throws(() => clock.schema.parse({ timezone: 42 }));
  assert.deepEqual(clock.schema.parse({}), {});
});

test("default tools are uniquely named and described", () => {
  const names = defaultTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of defaultTools) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
  }
});

test("calculator respects precedence and parentheses", async () => {
  assert.equal(await calculator.run({ expression: "2 + 3 * 4" }), "14");
  assert.equal(await calculator.run({ expression: "(2 + 3) * 4" }), "20");
  assert.equal(await calculator.run({ expression: "2 ** 3 ** 2" }), "512");
  assert.equal(await calculator.run({ expression: "(1200 * 1.13) / 3" }), "452");
});

test("calculator refuses anything that is not arithmetic", async () => {
  await assert.rejects(() => calculator.run({ expression: "process.exit(1)" }));
  await assert.rejects(() => calculator.run({ expression: "1 + fetch('x')" }));
  await assert.rejects(() => calculator.run({ expression: "1 / 0" }));
  await assert.rejects(() => calculator.run({ expression: "(1 + 2" }));
});

test("fetch_url rejects non-http schemes", async () => {
  await assert.rejects(() => fetchUrl.run({ url: "file:///etc/passwd" }), /http/);
});

// The guard itself is tested in @mini-agent/search; this asserts the web tools
// are actually wired through it rather than calling fetch() directly.
test("the web tools refuse to reach into our own network", async () => {
  for (const tool of [fetchUrl, scrapeUrl]) {
    await assert.rejects(
      () => tool.run({ url: "http://169.254.169.254/latest/meta-data/" }),
      /private address/,
      tool.name,
    );
    await assert.rejects(() => tool.run({ url: "http://localhost:5433/" }), /private address/, tool.name);
  }
});

test("web_search validates its input through the schema", () => {
  assert.deepEqual(webSearch.schema.parse({ query: "pnpm" }), { query: "pnpm" });
  assert.throws(() => webSearch.schema.parse({}));
  assert.throws(() => webSearch.schema.parse({ query: "pnpm", maxResults: "three" }));
});

test("the three web tools describe distinct jobs", () => {
  const names = defaultTools.map((tool) => tool.name);

  for (const name of ["web_search", "scrape_url", "fetch_url"]) {
    assert.ok(names.includes(name), `${name} is not registered`);
  }
  // Each description has to name the tool's own niche, or the model guesses.
  assert.match(webSearch.description, /search/i);
  assert.match(scrapeUrl.description, /markdown/i);
  assert.match(fetchUrl.description, /JSON/);
});
