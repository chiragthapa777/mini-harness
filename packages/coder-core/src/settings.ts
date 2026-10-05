import { z } from "zod";
import { parseRule } from "./gate.js";
import { parseModel } from "./model.js";
import type { SettingsSource, Store } from "./store.js";
import { PERMISSION_MODES, type SettingsScope } from "./wire.js";

const connection = z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() });

const schema = z.object({
  model: z.string().optional(), // "provider:model"
  mode: z.enum(PERMISSION_MODES).optional(),
  permissions: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) }).optional(),
  providers: z
    .object({ openrouter: connection, anthropic: connection, openai: connection, google: connection })
    .partial()
    .optional(),
  /** Run bash confined by the operating system. Off unless set. */
  sandbox: z.boolean().optional(),
  /** MCP servers by name, each a command to start. */
  mcpServers: z
    .record(
      z.string().regex(/^[\w-]+$/),
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export type Settings = z.infer<typeof schema>;
/** A settings file as written: every key optional. */
export type SettingsFile = z.input<typeof schema>;

/** Throws when the settings are not usable: an unknown key value, model or rule. */
function check(value: unknown): Settings {
  const settings = schema.parse(value);
  if (settings.model !== undefined) parseModel(settings.model);
  for (const rule of [...(settings.permissions?.allow ?? []), ...(settings.permissions?.deny ?? [])]) parseRule(rule);
  return settings;
}

/** One file as written, checked. No file, or an empty one, is no settings. Throws naming the file. */
function readSettingsFile(store: Store, source: SettingsSource): { raw: SettingsFile; settings: Settings } {
  try {
    const text = store.readSettings(source);
    const raw = (text.trim() ? JSON.parse(text) : {}) as SettingsFile;
    return { raw, settings: check(raw) };
  } catch (err) {
    const problem = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    throw new Error(`${store.settingsPath(source)}: ${problem}`);
  }
}

/**
 * Merges three files, most specific first:
 *
 * - local: this project's settings, kept by mini-coder outside the project.
 *   Written by the user or by mini-coder, so trusted like the user's.
 * - repo: `<root>/.mini-coder/settings.json`. It comes with the repository,
 *   so it is not trusted to loosen anything: only its `model`,
 *   `permissions.deny` and `sandbox: true` count. Otherwise cloning a
 *   repository could hand it your shell or your API keys.
 * - user: the user's settings, for every project.
 *
 * Allow and deny rules add up; for anything else the first file that sets it wins.
 */
export function loadSettings(store: Store): Settings {
  const local = readSettingsFile(store, "project").settings;
  const repo = readSettingsFile(store, "repo").settings;
  const user = readSettingsFile(store, "user").settings;

  return {
    model: local.model ?? repo.model ?? user.model,
    mode: local.mode ?? user.mode,
    providers: local.providers ?? user.providers,
    mcpServers: local.mcpServers ?? user.mcpServers,
    sandbox: (local.sandbox ?? user.sandbox ?? false) || (repo.sandbox ?? false),
    permissions: {
      allow: [...(local.permissions?.allow ?? []), ...(user.permissions?.allow ?? [])],
      deny: [...(local.permissions?.deny ?? []), ...(user.permissions?.deny ?? []), ...(repo.permissions?.deny ?? [])],
    },
  };
}

/**
 * Changes the user's or the local settings and keeps everything else in the
 * file. A file that is not valid is refused rather than overwritten, and a
 * change that would not load is never written.
 */
export async function updateSettings(
  store: Store,
  scope: SettingsScope,
  edit: (settings: SettingsFile) => void,
): Promise<void> {
  const { raw } = readSettingsFile(store, scope);
  edit(raw);
  check(raw);
  await store.writeSettings(scope, raw);
}

/** Adds an allow rule, like `bash(npm test)`, once. */
export function addAllowRule(settings: SettingsFile, rule: string): void {
  const permissions = (settings.permissions ??= {});
  const allow = (permissions.allow ??= []);
  if (!allow.includes(rule)) allow.push(rule);
}
