import type { Provider } from "@mini-agent/llm";

/**
 * Models are named `provider:model` on the wire — `openrouter:z-ai/glm-5.3-flash`,
 * `anthropic:claude-opus-5` — so one string says both which SDK to load and
 * what to ask it for. Only the first colon splits; model ids may contain more.
 */
const PROVIDERS = ["openrouter", "anthropic", "openai", "google"] as const satisfies readonly Provider[];

export const DEFAULT_MODEL = "openrouter:z-ai/glm-5.3-flash";

export interface ModelSpec {
  provider: Provider;
  model: string;
}

export function parseModel(spec: string): ModelSpec {
  const colon = spec.indexOf(":");
  const provider = spec.slice(0, colon);
  const model = spec.slice(colon + 1);

  if (colon <= 0 || !model) {
    throw new Error(`model must look like provider:model, got "${spec}"`);
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unknown provider "${provider}" — expected one of ${PROVIDERS.join(", ")}`);
  }
  return { provider: provider as Provider, model };
}

export function formatModel({ provider, model }: ModelSpec): string {
  return `${provider}:${model}`;
}
