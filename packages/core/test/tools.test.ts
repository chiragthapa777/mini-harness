import assert from "node:assert/strict";
import { test } from "node:test";
import { calculator, clock, defaultTools, fetchUrl } from "../src/tools.js";

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
