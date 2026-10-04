import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseRule } from "./gate.js";
import { parseModel } from "./model.js";
import { PERMISSION_MODES } from "./wire.js";

const connection = z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() });

const schema = z.object({
  model: z.string().optional(), // "provider:model"
  mode: z.enum(PERMISSION_MODES).optional(),
  permissions: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) }).optional(),
  providers: z
    .object({ openrouter: connection, anthropic: connection, openai: connection, google: connection })
    .partial()
    .optional(),
});

export type Settings = z.infer<typeof schema>;

function readSettings(file: string): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  try {
    const settings = schema.parse(JSON.parse(text));
    if (settings.model !== undefined) parseModel(settings.model);
    for (const rule of [...(settings.permissions?.allow ?? []), ...(settings.permissions?.deny ?? [])]) parseRule(rule);
    return settings;
  } catch (err) {
    const problem = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    throw new Error(`${file}: ${problem}`);
  }
}

/**
 * Merges the user's settings (`<home>/settings.json`) with the project's
 * (`<root>/.mini-coder/settings.json`).
 *
 * The project file comes with the repository, so it is not trusted to loosen
 * anything: from it only `model` and `permissions.deny` count. Its `mode`,
 * `permissions.allow` and `providers` are ignored — otherwise cloning a
 * repository could hand it your shell or your API keys.
 */
export function loadSettings(home: string, root: string): Settings {
  const user = readSettings(join(home, "settings.json"));
  const project = readSettings(join(root, ".mini-coder", "settings.json"));

  return {
    model: project.model ?? user.model,
    mode: user.mode,
    providers: user.providers,
    permissions: {
      allow: user.permissions?.allow ?? [],
      deny: [...(user.permissions?.deny ?? []), ...(project.permissions?.deny ?? [])],
    },
  };
}
