import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBlocks, parseInline, type Block } from "../src/markdown-parser.js";

/** Parsing is deliberately separate from rendering, so it tests without a terminal. */
const text = (spans: { text: string }[]) => spans.map((span) => span.text).join("");
const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);

describe("inline markdown", () => {
  it("leaves plain text alone", () => {
    assert.deepEqual(parseInline("just words"), [{ text: "just words" }]);
  });

  it("marks bold, italic, strikethrough, and code", () => {
    assert.deepEqual(parseInline("**b**"), [{ text: "b", bold: true }]);
    assert.deepEqual(parseInline("__b__"), [{ text: "b", bold: true }]);
    assert.deepEqual(parseInline("*i*"), [{ text: "i", italic: true }]);
    assert.deepEqual(parseInline("_i_"), [{ text: "i", italic: true }]);
    assert.deepEqual(parseInline("~~s~~"), [{ text: "s", strike: true }]);
    assert.deepEqual(parseInline("`c`"), [{ text: "c", code: true }]);
  });

  it("keeps the surrounding text in order", () => {
    const spans = parseInline("before **bold** after");
    assert.deepEqual(spans, [
      { text: "before " },
      { text: "bold", bold: true },
      { text: " after" },
    ]);
  });

  it("nests emphasis", () => {
    assert.deepEqual(parseInline("**bold with `code`**"), [
      { text: "bold with ", bold: true },
      { text: "code", code: true, bold: true },
    ]);
  });

  it("treats markers inside a code span as literal", () => {
    // The entire point of backticks: `**this**` must not turn bold.
    assert.deepEqual(parseInline("`**not bold**`"), [{ text: "**not bold**", code: true }]);
  });

  it("does not mistake mid-word underscores for italics", () => {
    assert.deepEqual(parseInline("snake_case_name"), [{ text: "snake_case_name" }]);
    assert.deepEqual(parseInline("a * b * c"), [{ text: "a * b * c" }]);
  });

  it("renders a link as its label, marked as a link", () => {
    assert.deepEqual(parseInline("see [the docs](https://example.com/a_b)"), [
      { text: "see " },
      { text: "the docs", link: true },
    ]);
  });

  it("falls back to the URL when a link has no label", () => {
    assert.deepEqual(parseInline("[](https://example.com)"), [
      { text: "https://example.com", link: true },
    ]);
  });

  it("leaves an unmatched marker as text rather than eating the rest", () => {
    assert.deepEqual(parseInline("2 * 3 = 6 and **done"), [{ text: "2 * 3 = 6 and **done" }]);
  });
});

describe("block markdown", () => {
  it("reads headings with their level", () => {
    const [heading] = parseBlocks("## Results");
    assert.equal(heading?.kind, "heading");
    assert.equal(heading!.kind === "heading" && heading.level, 2);
    assert.equal(heading!.kind === "heading" && text(heading.spans), "Results");
  });

  it("joins wrapped lines into one paragraph", () => {
    const blocks = parseBlocks("one line\ncontinues here");
    assert.deepEqual(kinds(blocks), ["paragraph"]);
    assert.equal(blocks[0]!.kind === "paragraph" && text(blocks[0]!.spans), "one line continues here");
  });

  it("reads bullet and numbered lists with their markers", () => {
    const blocks = parseBlocks("- first\n* second\n1. third\n2) fourth");
    assert.deepEqual(kinds(blocks), ["list", "list", "list", "list"]);
    assert.deepEqual(
      blocks.map((block) => (block.kind === "list" ? block.marker : "")),
      ["•", "•", "1.", "2."],
    );
  });

  it("keeps a fenced code block verbatim, with its language", () => {
    const blocks = parseBlocks("before\n```ts\nconst x = **1**;\n```\nafter");
    assert.deepEqual(kinds(blocks), ["paragraph", "code", "paragraph"]);

    const code = blocks[1]!;
    assert.equal(code.kind === "code" && code.language, "ts");
    assert.deepEqual(code.kind === "code" && code.lines, ["const x = **1**;"]);
  });

  it("renders an unterminated fence rather than dropping it", () => {
    // Exactly what a half-arrived stream looks like: the closing fence has not
    // been typed yet, and the user still needs to see the code.
    const blocks = parseBlocks("```py\nprint(1)");
    assert.deepEqual(kinds(blocks), ["code"]);
    assert.deepEqual(blocks[0]!.kind === "code" && blocks[0]!.lines, ["print(1)"]);
  });

  it("does not let a fence marker inside another fence close it early", () => {
    const blocks = parseBlocks("~~~\nsome ``` text\nmore\n~~~");
    assert.deepEqual(kinds(blocks), ["code"]);
    assert.deepEqual(blocks[0]!.kind === "code" && blocks[0]!.lines, ["some ``` text", "more"]);
  });

  it("reads quotes and horizontal rules", () => {
    assert.deepEqual(kinds(parseBlocks("> quoted\n\n---")), ["quote", "blank", "rule"]);
  });

  it("keeps blank lines so paragraphs stay apart", () => {
    assert.deepEqual(kinds(parseBlocks("one\n\ntwo")), ["paragraph", "blank", "paragraph"]);
  });

  it("returns nothing for an empty reply", () => {
    assert.deepEqual(parseBlocks(""), []);
  });
});
