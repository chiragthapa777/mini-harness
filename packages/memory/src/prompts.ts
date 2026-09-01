import { getConfig } from "@mini-agent/config";

/**
 * Memory's own prompts. Versioned and kept together for the same reason the
 * agent's system prompt is: they are config that gets released, not strings
 * inlined at three different call sites.
 *
 * Bump `MEMORY_PROMPT_VERSION` when the wording changes meaningfully — the
 * summaries and facts already in the database were written by an older one.
 */
export const MEMORY_PROMPT_VERSION = "1";

/**
 * Conversation recap. The output is what episodic retrieval ranks, so it is
 * written to be *matched* — concrete nouns over narration, no preamble.
 */
export function conversationSummaryPrompt(maxWords = getConfig().memory.summaryMaxWords): string {
  return [
    "You summarize a conversation between a user and their AI assistant.",
    "",
    `Write a single recap of UNDER ${maxWords} words. Hard limit.`,
    "",
    "Rules:",
    "- Write plain prose. No headings, no bullet points, no preamble.",
    "- Lead with what the user wanted and what was decided or delivered.",
    "- Keep concrete details worth finding later: names, dates, numbers,",
    "  places, file names, decisions, and any commitment either side made.",
    "- Drop pleasantries, retries, and anything the assistant merely offered.",
    "- Write it as a record of what happened, in the past tense.",
    "- If an earlier summary is supplied, rewrite it to cover the new messages",
    "  too. Do not append to it, and do not lose facts it already had.",
    "- Output the summary and nothing else.",
  ].join("\n");
}

/**
 * Fact extraction for consolidation. Durable and self-contained is the whole
 * point: a fact is read back months later with none of its conversation.
 */
export const FACT_EXTRACTION_PROMPT = [
  "You distil durable facts about a user from their conversation history.",
  "",
  "Output one fact per line. No numbering, no bullets, no commentary.",
  "Output nothing at all if there is nothing durable worth keeping.",
  "",
  "A fact qualifies only if it is:",
  "- about the user, their preferences, their circumstances, their people,",
  "  their projects, or a standing instruction they gave the assistant,",
  "- still true tomorrow — not a passing mood, a one-off question, or",
  "  anything about what the assistant did,",
  "- self-contained: readable months later with none of this conversation.",
  '  Write "Chirag lives in Kathmandu", never "he lives there".',
  "",
  "Keep each fact to one short sentence. Prefer fewer, better facts.",
].join("\n");

/**
 * Merging near-duplicates. Contradictions resolve by recency, and the merge is
 * allowed to *replace* rather than concatenate — otherwise a stale fact
 * survives forever glued to the one that corrected it.
 */
export const FACT_MERGE_PROMPT = [
  "You merge a cluster of near-duplicate facts about one user into a single fact.",
  "",
  "Rules:",
  "- Output exactly one short, self-contained sentence. Nothing else.",
  "- If the facts agree, state the shared fact once, keeping the most specific",
  "  detail from any of them.",
  "- If they contradict, keep only what the most recent one says and discard",
  "  the rest. Never write a sentence that holds both versions.",
  "- Do not invent anything that is not in the inputs.",
].join("\n");
