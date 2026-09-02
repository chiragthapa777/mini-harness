import { SYSTEM_PROMPT, defaultTools, runAgent, runConfig } from "@mini-agent/core";
import { loadProcedural } from "@mini-agent/memory";

const prompt = process.argv[2] ?? "what time is it in Kathmandu?";
const procedural = await loadProcedural();

const result = await runAgent(
  {
    systemPrompt: SYSTEM_PROMPT,
    procedural,
    semantic: [],
    events: [],
    episodic: [],
    history: [],
    userPrompt: prompt,
  },
  defaultTools,
  runConfig(),
);

const labels = [...result.reply.matchAll(/^(GOAL|NEED|PLAN|RISK|BLOCKED):/gm)].map((m) => m[1]);

console.log("skills loaded:", procedural.length);
console.log("label order:", labels.join(" -> ") || "(none)");
console.log("stop:", result.trace.stopReason, "| iterations:", result.trace.iterations);
console.log("reply:\n" + result.reply);
