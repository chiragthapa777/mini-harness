import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The path guard for file tools. Paths come from the model, so: follow
 * symlinks, stay inside the project, and keep away from secrets and from
 * mini-coder's own settings. (bash is not covered; that is phase 5.)
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

/** Follows symlinks. A file that does not exist yet is resolved through its folder. */
async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const folder = await realpath(dirname(path)).catch(() => dirname(path));
    return join(folder, basename(path));
  }
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

function isOffLimits(root: string, path: string): boolean {
  const home = homedir();
  if (isInside(path, join(home, ".ssh")) || isInside(path, join(home, ".mini-coder"))) return true;

  const name = basename(path);
  if (name.startsWith(".env") && name !== ".env.example") return true;

  const rel = relative(root, path);
  return rel === join(".mini-coder", "settings.json") || rel === join(".mini-coder", "settings.local.json");
}
