/**
 * Provider selection lives in `@mini-agent/llm`, which owns every line that
 * names a vendor. The harness works against `ChatClient` — two methods — so
 * swapping providers is config, not code.
 *
 * Re-exported here because the loop has always reached for `./provider.js`,
 * and because this is the seam worth keeping if the transport ever moves again.
 */
export { chatModel } from "@mini-agent/llm";
export type { ChatClient } from "@mini-agent/llm";
