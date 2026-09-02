import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The JWT, cached between runs so a terminal session does not start with a
 * password prompt every time.
 *
 * `~/.mini-agent/token`, written 0600. It is a bearer token for the whole
 * account: file permissions are the only thing standing between it and every
 * other process running as this user.
 */
const TOKEN_PATH = join(homedir(), ".mini-agent", "token");

export async function readToken(): Promise<string | null> {
  try {
    const token = await readFile(TOKEN_PATH, "utf8");
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function writeToken(token: string): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
}

export async function clearToken(): Promise<void> {
  await rm(TOKEN_PATH, { force: true });
}
