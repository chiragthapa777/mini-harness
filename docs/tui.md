# Installing the TUI

`apps/tui` is a gateway, not a copy of the agent: it talks to the same API the web app
does. Installing it puts a `mini-agent` command on your PATH that points at a running
API server — the server is what does the work.

## Build

```sh
pnpm --filter @mini-agent/tui build
```

Produces one executable file, `apps/tui/dist/mini-agent.mjs` (~2.4 MB), with a shebang
and mode 0755. It is a bundle rather than a package with dependencies because the TUI
imports `@mini-agent/config`, a workspace package that is not published — `npm i -g`
could never resolve it. Bundling also means the installed command has no `node_modules`
to keep in step with the repo.

Node 22+ has to be on the machine. See *Standalone binary* below for the version that
does not need it.

## Install

Any of these; they differ only in how the command gets onto your PATH.

**Global install from the workspace** — the usual one:

```sh
pnpm --filter @mini-agent/tui build
cd apps/tui && npm install -g .
mini-agent --help
```

**Symlink instead of copy**, so a rebuild takes effect without reinstalling:

```sh
cd apps/tui && pnpm link --global
```

**Just copy the file** — no npm involved, and the whole thing is one file:

```sh
cp apps/tui/dist/mini-agent.mjs ~/.local/bin/mini-agent
```

Uninstall is `npm uninstall -g @mini-agent/tui`, `pnpm unlink --global`, or deleting the
file, matching whichever you used.

## Pointing it at a server

The installed command has no `.env` next to it, so the API address comes from a flag or
the environment:

```sh
mini-agent --api https://agent.example.com     # per run
export API_URL=https://agent.example.com       # for the shell
```

Default is `http://localhost:3001`, which is what `pnpm dev` serves.

Sign-in is email and password, the same account the web app uses; there is no
self-registration anywhere in this project, so an admin creates the account first. The
JWT is cached in `~/.mini-agent/token` (mode 0600) and validated on start, so an expired
token drops you back to the prompt instead of failing on the first message.

## Standalone binary

If the target machine has no Node, the bundle can be turned into a single executable:

```sh
# Node's own single-executable applications (SEA), Node 22+
node --experimental-sea-config sea-config.json

# or, if you have bun
bun build --compile apps/tui/dist/mini-agent.mjs --outfile mini-agent
```

Both inline a Node runtime, so expect ~50-110 MB per file and one build per platform
(macOS arm64, macOS x64, linux x64, …) plus code-signing on macOS. That is a real
release pipeline rather than a build step, which is why it is not wired up here — the
2.4 MB bundle is the version worth having until someone needs to install this somewhere
Node is not.

## Running from the repo

No build needed while developing:

```sh
pnpm --filter @mini-agent/tui dev
```

That runs the TypeScript directly through `tsx` and reads the repo's `.env`, so
`API_URL` and everything else come from the same place the API server gets them.
