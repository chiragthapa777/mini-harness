# Installing mini-coder

`mini-coder` is one file. It needs Node 22 or newer and an API key for a model provider.

## Install

Download the latest release onto your PATH:

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/chiragthapa777/mini-harness/releases/latest/download/mini-coder.mjs -o ~/.local/bin/mini-coder
chmod +x ~/.local/bin/mini-coder
mini-coder --version
```

If `mini-coder` is not found, add `~/.local/bin` to your PATH.

Give it a key, either in the environment or in `~/.mini-coder/settings.json`:

```sh
export OPENROUTER_API_KEY=sk-or-...
```

```json
{ "providers": { "openrouter": { "apiKey": "sk-or-..." } } }
```

Every setting is listed under *Settings* below.

## Use

```sh
cd your-project
mini-coder                    # interactive; type / for commands and skills
mini-coder -p "run the tests" # one turn, reply on stdout
mini-coder --resume           # continue the last session in this folder
```

## Settings

`~/.mini-coder/settings.json`. Every key is optional, and flags win over the file.

```json
{
  "model": "openrouter:z-ai/glm-5.3-flash",
  "mode": "default",
  "sandbox": false,
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1" },
    "google": { "apiKey": "..." }
  },
  "permissions": {
    "allow": ["bash(npm test:*)", "bash(git status)", "edit_file", "github__create_issue"],
    "deny": ["bash(git push:*)"]
  },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "timeoutMs": 30000
    }
  }
}
```

- `model`: `provider:model`. Providers: `openrouter`, `anthropic`, `openai`, `google`.
- `mode`: `default` (writes and commands ask), `accept-edits` (writes run), `plan` (read-only), `bypass` (nothing asks).
- `sandbox`: `true` confines bash to the project. macOS only.
- `providers`: a key here is used before the environment variable.
- `permissions`: a rule is `tool`, `tool(command)` for exactly that command, or `tool(command:*)` for that command plus arguments. Deny wins. MCP tools are named `server__tool`.
- `mcpServers`: each entry is a command that starts a server over stdio.

A project can have its own `.mini-coder/settings.json`, but it is not trusted: only `model`, `permissions.deny` and `"sandbox": true` are read from it.

## Update

Run the three install commands again: they replace the file with the newest release. `mini-coder --version` shows what you have. Settings, memory and session logs live in `~/.mini-coder` and are not touched.

A specific version: replace `latest/download` with `download/coder-v0.3.0`.

## Uninstall

```sh
rm ~/.local/bin/mini-coder
rm -rf ~/.mini-coder   # settings, memory and session logs too
```

## From source

```sh
pnpm install
pnpm build:coder
cp apps/coder/dist/mini-coder.mjs ~/.local/bin/mini-coder
```

## Releasing

Push a tag with the `coder-` prefix: `git tag coder-v0.3.0 && git push origin coder-v0.3.0`. The `Release mini-coder` workflow tests, builds and attaches `mini-coder.mjs` and its checksum to that release.

mini-coder and the server have separate versions. Plain `v*` tags release the server images and nothing else ([deploy.md](deploy.md)).
