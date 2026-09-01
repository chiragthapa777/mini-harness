import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/html.js";
import { extractContent, extractTitle } from "../src/scrape.js";
import { ARTICLE_HTML, PLAIN_HTML } from "./fixtures/article.js";

const BASE = "https://example.com/blog/post";

function content(html: string): string {
  return extractContent(parse(html), BASE);
}

test("keeps the article and drops nav, header, aside, and footer", () => {
  const output = content(ARTICLE_HTML);

  assert.match(output, /A workspace links packages/);
  for (const chrome of ["Nav A", "Nav B", "Related", "Something else", "2026"]) {
    assert.doesNotMatch(output, new RegExp(chrome), `chrome leaked: ${chrome}`);
  }
});

test("drops script and style bodies", () => {
  const output = content(ARTICLE_HTML);

  assert.doesNotMatch(output, /analytics/);
  assert.doesNotMatch(output, /color: red/);
});

test("emits markdown structure the model can use", () => {
  const output = content(ARTICLE_HTML);

  assert.match(output, /^# How pnpm workspaces work$/m);
  assert.match(output, /^## Linking$/m);
  assert.match(output, /^- Every package resolves from the store$/m);
  assert.match(output, /```\npnpm install\npnpm -r build\n```/);
  assert.match(output, /`node_modules`/);
});

test("resolves relative links against the page URL", () => {
  const output = content(ARTICLE_HTML);

  assert.match(output, /\[the workspace protocol\]\(https:\/\/example\.com\/docs\/protocol\)/);
});

test("decodes entities", () => {
  assert.match(content(ARTICLE_HTML), /Café & croissants cost 5 €\./);
});

test("falls back to body when there is no article or main", () => {
  const output = content(PLAIN_HTML);

  assert.match(output, /^# Plain page$/m);
  assert.match(output, /First para\./);
  assert.match(output, /Second para\./);
});

test("paragraphs stay on separate lines and blank runs collapse", () => {
  const output = content(PLAIN_HTML);

  assert.doesNotMatch(output, /\n{3,}/);
  assert.match(output, /First para\.\n\nSecond para\./);
});

test("title comes from <title>, then the first h1", () => {
  assert.equal(extractTitle(parse(ARTICLE_HTML)), "How pnpm workspaces work");
  assert.equal(extractTitle(parse("<h1>Only a heading</h1>")), "Only a heading");
  assert.equal(extractTitle(parse("<p>nothing</p>")), "");
});
