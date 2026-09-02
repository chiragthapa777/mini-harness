import { getConfig } from "@mini-agent/config";
import { chunkText } from "./chunk.js";
import { writeFact, type Fact } from "./semantic.js";

/**
 * Loading a document into semantic memory.
 *
 * Uploaded material is not the same as a distilled fact — it is reference
 * text, kept verbatim so a citation is possible — but it lives in the same
 * table because retrieval is the same question either way. The `source` names
 * the file and the chunk index, so a retrieved passage can be traced back to
 * where it came from.
 *
 * Embeddings are queued, not awaited: a 200-chunk upload would otherwise be
 * 200 serial round-trips on the request.
 */

export interface IngestOptions {
  kind?: Fact["kind"];
  maxChars?: number;
  overlapChars?: number;
}

export interface IngestResult {
  filename: string;
  chunks: number;
  factIds: string[];
}

export async function ingestDocument(
  userId: string,
  filename: string,
  content: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { uploadChunkChars, uploadChunkOverlap } = getConfig().memory;

  const chunks = chunkText(content, {
    maxChars: options.maxChars ?? uploadChunkChars,
    overlapChars: options.overlapChars ?? uploadChunkOverlap,
  });
  if (chunks.length === 0) throw new Error("nothing to ingest — the file is empty");

  const factIds: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    // `file:<name>#<n>` rather than just the filename: re-uploading an edited
    // file overwrites chunk-for-chunk via writeFact's exact-match dedup, and a
    // retrieved passage says which part of which file it came from.
    factIds.push(await writeFact(userId, chunk, options.kind ?? "fact", `file:${filename}#${index}`));
  }

  return { filename, chunks: chunks.length, factIds };
}
