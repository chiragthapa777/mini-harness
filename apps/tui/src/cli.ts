/**
 * Argument handling for the installed CLI.
 *
 * Run from the repo, the TUI gets its settings from `.env` like every other
 * app. Installed as a binary there is no `.env` anywhere near it, so the API
 * it talks to has to be answerable on the command line — `--api` writes
 * straight into the environment `@mini-agent/config` reads, which keeps this
 * file the only place that knows the CLI has flags at all.
 */

/** Replaced at build time; `dev` when running from source. */
declare const __TUI_VERSION__: string | undefined;

export const version = typeof __TUI_VERSION__ === "string" ? __TUI_VERSION__ : "dev";

const HELP = `mini-agent — chat with your agent from the terminal

Usage
  mini-agent [options]

Options
  --api <url>     API server to talk to (default: $API_URL or http://localhost:3001)
  -h, --help      Show this message
  -v, --version   Show the version

In the chat
  /new            Start a fresh conversation
  /logout         Forget the saved sign-in
  /quit           Exit
  esc             Cancel a reply that is still streaming

The sign-in token is cached in ~/.mini-agent/token.`;

export interface CliResult {
  /** Set when the process should print something and exit instead of starting. */
  exit?: { message: string; code: number };
}

/**
 * Parses argv, applying anything that belongs in the environment. Returns what
 * to print and exit with, if the run should not continue.
 */
export function applyArgs(argv: string[] = process.argv.slice(2)): CliResult {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "-h" || arg === "--help") return { exit: { message: HELP, code: 0 } };
    if (arg === "-v" || arg === "--version") return { exit: { message: version, code: 0 } };

    if (arg === "--api" || arg === "--api-url") {
      const value = argv[++i];
      if (!value) return { exit: { message: `${arg} needs a URL`, code: 1 } };
      process.env.API_URL = value;
      continue;
    }

    const inline = /^--api(?:-url)?=(.+)$/.exec(arg);
    if (inline) {
      process.env.API_URL = inline[1]!;
      continue;
    }

    return { exit: { message: `unknown option: ${arg}\n\n${HELP}`, code: 1 } };
  }

  return {};
}
