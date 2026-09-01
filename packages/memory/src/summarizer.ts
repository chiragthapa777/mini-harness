import { getConfig } from "@mini-agent/config";
import { chatModel, type ChatClient, type Msg } from "@mini-agent/llm";

/**
 * Memory's own model calls. Small, cheap, and nothing like the agent loop:
 * one prompt, one completion, no tools and no iterations. Config picks the
 * model (`SUMMARY_MODEL`, defaulting to whatever the agent uses) so a summary
 * pass can run on something cheaper than the chat model.
 */
export function summaryModel(): ChatClient {
  const { memory } = getConfig();
  return chatModel(memory.summaryProvider, memory.summaryModel, memory.summaryMaxTokens);
}

/** One system prompt, one user turn, text back. */
export async function complete(
  systemPrompt: string,
  userContent: string,
  model: ChatClient = summaryModel(),
): Promise<string> {
  const messages: Msg[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const response = await model.invoke(messages);
  return response.text.trim();
}

/**
 * A model asked for "under 200 words" will sometimes hand back 240. The cap is
 * a storage guarantee, not a request, so it is enforced here as well.
 */
export function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}
