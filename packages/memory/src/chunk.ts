/**
 * Splitting a document into retrievable pieces.
 *
 * The unit that matters is the *retrieved* unit: one chunk is what comes back
 * from a top-k search and lands in the prompt, so it has to make sense read on
 * its own. Two rules follow from that, and they are the whole design:
 *
 *   - Split on the boundaries the author already wrote. A paragraph break is a
 *     free semantic boundary; cutting mid-sentence to hit an exact size is not
 *     worth the bytes it saves.
 *   - Overlap consecutive chunks. A fact stated across a boundary otherwise
 *     belongs to neither chunk, and the overlap is what keeps it findable.
 *
 * Pure text in, pure text out — no database, no embeddings, no model.
 */

export interface ChunkOptions {
  /** Soft ceiling. A paragraph that overshoots slightly is kept whole. */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next. */
  overlapChars?: number;
}

export function chunkText(
  text: string,
  { maxChars = 1000, overlapChars = 150 }: ChunkOptions = {},
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const overlap = Math.min(overlapChars, Math.floor(maxChars / 2));
  const blocks = splitBlocks(normalized, maxChars);

  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    if (current.length + block.length + 2 <= maxChars) {
      current = `${current}\n\n${block}`;
      continue;
    }
    chunks.push(current);
    current = overlap > 0 ? join(tail(current, overlap), block) : block;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Paragraphs, then sentences for a paragraph that is too big on its own, then
 * a hard cut for a "sentence" that is really a wall of text (minified JSON, a
 * table, a base64 blob).
 */
function splitBlocks(text: string, maxChars: number): string[] {
  const blocks: string[] = [];

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxChars) {
      blocks.push(trimmed);
      continue;
    }

    let buffer = "";
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > maxChars) {
        if (buffer) {
          blocks.push(buffer);
          buffer = "";
        }
        for (let i = 0; i < sentence.length; i += maxChars) {
          blocks.push(sentence.slice(i, i + maxChars));
        }
        continue;
      }
      if (!buffer) {
        buffer = sentence;
      } else if (buffer.length + sentence.length + 1 <= maxChars) {
        buffer = `${buffer} ${sentence}`;
      } else {
        blocks.push(buffer);
        buffer = sentence;
      }
    }
    if (buffer) blocks.push(buffer);
  }

  return blocks;
}

/** The last `count` characters, snapped forward to a word boundary. */
function tail(text: string, count: number): string {
  const slice = text.slice(-count);
  const space = slice.search(/\s/);
  return (space === -1 ? slice : slice.slice(space + 1)).trim();
}

function join(overlap: string, block: string): string {
  return overlap ? `${overlap}\n\n${block}` : block;
}
