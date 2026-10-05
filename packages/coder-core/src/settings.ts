import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseRule } from "./gate.js";
import { parseModel } from "./model.js";
import { projectFolder } from "./sessions.js";
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

/**
 * The settings files mini-coder writes to: the user's, for every project, and
 * this project's own. Both live in `<home>`, outside the project, so they are
 * never committed and a cloned repository cannot bring one along.
 */
export function settingsFile(home: string, root: string, scope: SettingsScope): string {
  return join(scope === "user" ? home : projectFolder(home, root), "settings.json");
}

/** The file's text, or "{}" when there is none. */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw err;
  }
}

/** Throws when the settings are not usable: an unknown key value, model or rule. */
function check(value: unknown): Settings {
  const settings = schema.parse(value);
  if (settings.model !== undefined) parseModel(settings.model);
  for (const rule of [...(settings.permissions?.allow ?? []), ...(settings.permissions?.deny ?? [])]) parseRule(rule);
  return settings;
}

function readSettings(file: string): Settings {
  try {
    return check(JSON.parse(readText(file)));
  } catch (err) {
    const problem = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    throw new Error(`${file}: ${problem}`);
  }
}

/**
 * Merges three files, most specific first:
 *
 * - local: this project's settings in `<home>/projects/<slug>/settings.json`.
 *   Written by the user or by mini-coder, so trusted like the user's.
 * - repo: `<root>/.mini-coder/settings.json`. It comes with the repository,
 *   so it is not trusted to loosen anything: only its `model`,
 *   `permissions.deny` and `sandbox: true` count. Otherwise cloning a
 *   repository could hand it your shell or your API keys.
 * - user: `<home>/settings.json`, for every project.
 *
 * Allow and deny rules add up; for anything else the first file that sets it wins.
 */
export function loadSettings(home: string, root: string): Settings {
  const local = readSettings(settingsFile(home, root, "project"));
  const repo = readSettings(join(root, ".mini-coder", "settings.json"));
  const user = readSettings(settingsFile(home, root, "user"));

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
 * Changes one settings file and keeps everything else in it. A file that is
 * not valid is refused rather than overwritten. Written to a temporary file
 * and renamed, so a crash cannot leave half a file.
 */
export async function updateSettings(file: string, edit: (settings: SettingsFile) => void): Promise<void> {
  readSettings(file); // throws, naming the file, when it is broken
  const settings = JSON.parse(readText(file)) as SettingsFile;
  edit(settings);
  check(settings); // never write a file that would not load

  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2) + "\n");
  await rename(temp, file);
}

/** Adds an allow rule, like `bash(npm test)`, once. */
export function addAllowRule(settings: SettingsFile, rule: string): void {
  const permissions = (settings.permissions ??= {});
  const allow = (permissions.allow ??= []);
  if (!allow.includes(rule)) allow.push(rule);
}
