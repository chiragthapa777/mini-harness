import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The path guard every file tool goes through. Paths come from model output,
 * so they are untrusted: resolve them the way the OS will (symlinks
 * included), then refuse anything outside the project root and anything on
 * the deny list.
 *
 * This covers the file tools only. `bash` can still name any path; parsing
 * commands for that is phase 5's permission work.
 */

/** `.env`, `.env.local`, `.env.production`, … but not the committed example. */
function isEnvFile(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * A path that may not exist yet (a file about to be created) is resolved
 * through its nearest existing ancestor, so a symlinked directory cannot
 * smuggle a new file outside the project.
 */
async function resolveReal(path: string): Promise<string> {
  const whole = await realpathOrNull(path);
  if (whole) return whole;

  const missing: string[] = [];
  let current = path;
  for (;;) {
    const parent = resolve(current, "..");
    missing.unshift(basename(current));
    if (parent === current) return path;
    const real = await realpathOrNull(parent);
    if (real) return join(real, ...missing);
    current = parent;
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

let deniedRoots: Promise<string[]> | undefined;

/** Resolved lazily and once: home may be a symlink too. */
function homeDenials(): Promise<string[]> {
  deniedRoots ??= (async () => {
    const home = (await realpathOrNull(homedir())) ?? homedir();
    return [join(home, ".ssh"), join(home, ".mini-coder")];
  })();
  return deniedRoots;
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/** Returns the real, absolute path, or throws a `PathError` the model can read and act on. */
export async function resolveInProject(root: string, input: string): Promise<string> {
  const requested = isAbsolute(input) ? input : resolve(root, input);
  const real = await resolveReal(requested);

  if (!inside(real, root)) {
    throw new PathError(`${input} is outside the project (${root}); only files inside it are reachable`);
  }
  for (const denied of await homeDenials()) {
    if (inside(real, denied)) throw new PathError(`${input} is off limits`);
  }
  if (isEnvFile(basename(real))) {
    throw new PathError(`${input} looks like a secrets file (.env*) and is off limits`);
  }
  // The harness's own settings: an agent must not grant itself permissions.
  const rel = relative(root, real);
  if (/^\.mini-coder[/\\]settings(\.local)?\.json$/.test(rel)) {
    throw new PathError(`${input} is mini-coder's own configuration and is off limits`);
  }
  return real;
}

/** For messages: project-relative when inside the root. */
export function display(root: string, path: string): string {
  return inside(path, root) && path !== root ? relative(root, path) : path;
}
