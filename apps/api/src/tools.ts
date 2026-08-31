import { defaultTools, type AgentTool } from "@mini-agent/core";
import { recall, searchFacts, writeFact } from "@mini-agent/memory";
import { z } from "zod";

/**
 * Memory tools are bound to a user, so they are built per run rather than
 * being module-level constants like the stateless ones in core.
 *
 * Retrieval already happens automatically before every run; these let the
 * agent go back for more when the automatic slice was not enough, and let it
 * commit something worth keeping without waiting for consolidation.
 */
export function toolsFor(userId: string): AgentTool[] {
  const remember: AgentTool = {
    name: "remember",
    description:
      "Save a durable fact about the user to long-term memory. Use for stable " +
      "preferences and details worth recalling in later conversations, not for " +
      "passing remarks.",
    schema: z.object({
      fact: z.string().describe("One self-contained sentence, e.g. 'Prefers Neovim'"),
    }),
    async run({ fact }) {
      await writeFact(userId, String(fact), "fact", "agent");
      return `remembered: ${fact}`;
    },
  };

  const searchMemory: AgentTool = {
    name: "search_memory",
    description:
      "Search long-term memory for facts and past conversation turns. Use when " +
      "the user refers to something from an earlier conversation.",
    schema: z.object({
      query: z.string().describe("What to look for"),
    }),
    async run({ query }) {
      const q = String(query);
      const [facts, episodes] = await Promise.all([searchFacts(userId, q), recall(userId, q, 5)]);

      const lines = [
        ...facts.map((f) => `fact: ${f.content}`),
        ...episodes.map((e) => `${e.created_at.toISOString()} ${e.role}: ${e.content}`),
      ];
      return lines.length ? lines.join("\n") : "nothing found in memory";
    },
  };

  return [...defaultTools, remember, searchMemory];
}
