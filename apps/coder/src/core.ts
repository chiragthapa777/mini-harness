import { Session, type Core, type CoreMessage, type PermissionMode } from "@mini-agent/coder-core";
import { defaultTools } from "@mini-agent/coder-tools";
import { chatModel } from "@mini-agent/llm";

/** Output-token ceiling per model call. */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Builds the core for a UI to drive — the one file that imports coder-core,
 * coder-tools and llm together. Throws when the folder or the model is not usable.
 */
export function startCore(options: { cwd: string; model?: string; mode?: PermissionMode }): Core {
  // The session speaks as soon as it exists; keep that until the UI listens.
  const early: CoreMessage[] = [];
  let handler = (message: CoreMessage): void => void early.push(message);

  const session = new Session((message) => handler(message), {
    ...options,
    tools: defaultTools,
    createModel: ({ provider, model }) => chatModel(provider, model, MAX_OUTPUT_TOKENS),
  });

  return {
    send: (message) => session.receive(message),
    onMessage(next) {
      handler = next;
      for (const message of early.splice(0)) next(message);
    },
    stop: () => session.stop(),
  };
}
