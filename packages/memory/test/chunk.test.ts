import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkText } from "../src/chunk.js";

/** Pure function, no database — these run everywhere. */
describe("chunkText", () => {
  it("leaves a short document whole", () => {
    assert.deepEqual(chunkText("one paragraph, well under the limit."), [
      "one paragraph, well under the limit.",
    ]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("   \n\n  \t "), []);
  });

  it("packs whole paragraphs together rather than cutting at an exact size", () => {
    const paragraphs = ["a".repeat(60), "b".repeat(60), "c".repeat(60)];
    const chunks = chunkText(paragraphs.join("\n\n"), { maxChars: 130, overlapChars: 0 });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], `${paragraphs[0]}\n\n${paragraphs[1]}`);
    assert.equal(chunks[1], paragraphs[2]);
  });

  it("overlaps consecutive chunks so a boundary-straddling fact stays findable", () => {
    const text = `${"alpha ".repeat(30)}\n\n${"bravo ".repeat(30)}`;
    const chunks = chunkText(text, { maxChars: 200, overlapChars: 40 });

    assert.ok(chunks.length >= 2);
    const carried = chunks[1]!.split("\n\n")[0]!;
    assert.ok(chunks[0]!.endsWith(carried), "the overlap is the tail of the previous chunk");
    assert.ok(carried.startsWith("alpha"), "and it starts on a word boundary, not mid-word");
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} is here.`);
    const chunks = chunkText(sentences.join(" "), { maxChars: 90, overlapChars: 0 });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 90, `chunk over the limit: ${chunk.length}`);
      assert.match(chunk, /\.$/, "chunks end where a sentence does");
    }
  });

  it("hard-splits text with no boundaries at all", () => {
    const blob = "x".repeat(500);
    const chunks = chunkText(blob, { maxChars: 100, overlapChars: 0 });

    assert.equal(chunks.length, 5);
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
    assert.equal(chunks.join(""), blob, "nothing is dropped");
  });

  it("never loses content when packing", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some words in it.`).join(
      "\n\n",
    );
    const chunks = chunkText(text, { maxChars: 120, overlapChars: 0 });

    for (let i = 0; i < 20; i++) {
      assert.ok(
        chunks.some((chunk) => chunk.includes(`Paragraph ${i} `)),
        `paragraph ${i} went missing`,
      );
    }
  });

  it("caps the overlap at half a chunk, however much is asked for", () => {
    const text = `${"alpha ".repeat(20)}\n\n${"bravo ".repeat(20)}\n\n${"charlie ".repeat(20)}`;
    const chunks = chunkText(text, { maxChars: 120, overlapChars: 500 });

    // A runaway overlap would make each chunk mostly a copy of the last, or
    // loop forever; both show up as chunks longer than the ceiling.
    assert.ok(chunks.every((chunk) => chunk.length <= 240));
  });
});
