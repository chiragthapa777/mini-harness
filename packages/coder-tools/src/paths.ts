import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The path guard for file tools. Paths come from the model, so: follow
 * symlinks, stay inside the project, and keep away from secrets and from
 * mini-coder's own settings. (bash does not come through here; the
 * permission gate blocks commands that name these files.)
 */
export async function resolveInProject(root: string, input: string): Promise<string> {
  const path = resolve(root, input);
  const real = await realpathOf(path);

  if (!isInside(real, root)) {
    throw new Error(`${input} is outside the project (${root})`);
  }
  if (isOffLimits(root, real)) {
    throw new Error(`${input} is off limits`);
  }
  return real;
}

/** Shows a path relative to the project root when it is inside it. */
export function display(root: string, path: string): string {
  return isInside(path, root) && path !== root ? relative(root, path) : path;
}

/**
 * Follows symlinks. A path that does not exist yet is resolved through its
 * nearest existing folder, so `link/new/file` cannot escape through `link`.
 */
async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realpathOf(parent), basename(path));
  }
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

/** Secrets and mini-coder's own settings: no tool may read, list or change them. */
export function isOffLimits(root: string, path: string): boolean {
  const home = homedir();
  if (isInside(path, join(home, ".ssh")) || isInside(path, join(home, ".mini-coder"))) return true;

  const name = basename(path);
  if (name.startsWith(".env") && name !== ".env.example") return true;

  const rel = relative(root, path);
  return rel === join(".mini-coder", "settings.json") || rel === join(".mini-coder", "settings.local.json");
}
