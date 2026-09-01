import { defaultTools, type AgentTool } from "@mini-agent/core";
import { recallEvents, searchFacts, searchMessages, writeFact } from "@mini-agent/memory";
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
      "Search long-term memory: durable facts, recaps of past conversations, " +
      "and the exact wording of individual past messages. Use when the user " +
      "refers to something from an earlier conversation.",
    schema: z.object({
      query: z.string().describe("What to look for"),
    }),
    async run({ query }) {
      const q = String(query);
      // Recaps answer "what happened"; the verbatim turns are there for when
      // the exact wording matters and a summary has flattened it.
      const [facts, events, messages] = await Promise.all([
        searchFacts(userId, q),
        recallEvents(userId, q, 5),
        searchMessages(userId, q, 5),
      ]);

      const lines = [
        ...facts.map((f) => `fact: ${f.content}`),
        ...events.map((e) => `${e.occurred_at.toISOString().slice(0, 10)} recap: ${e.summary}`),
        ...messages.map((m) => `${m.created_at.toISOString()} ${m.role}: ${m.content}`),
      ];
      return lines.length ? lines.join("\n") : "nothing found in memory";
    },
  };

  return [...defaultTools, remember, searchMemory];
}
