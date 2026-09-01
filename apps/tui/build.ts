import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles the TUI into one executable file.
 *
 * A bundle rather than a published package with dependencies, because the TUI
 * imports `@mini-agent/config`, a workspace package that is not on npm — `npm
 * i -g` could never resolve it. Bundling also means the installed CLI is a
 * single file with no `node_modules` to keep in step with the repo.
 *
 * The output still needs Node on the machine. For a binary that does not, see
 * `docs/tui.md` — that is a different trade (≈50 MB, per-platform builds), and
 * this is the version worth having first.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "dist/mini-agent.mjs");

await mkdir(dirname(outfile), { recursive: true });

const { version } = JSON.parse(
  await readFile(resolve(here, "package.json"), "utf8"),
) as { version: string };

const result = await build({
  entryPoints: [resolve(here, "src/index.tsx")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Not minified: this is a CLI whose stack traces someone may have to read,
  // and the download is a local file copy either way.
  minify: false,
  sourcemap: false,
  banner: {
    js: [
      // The one and only shebang: Node strips it on line 1 and nowhere else,
      // so the entry source must not carry one of its own.
      "#!/usr/bin/env node",
      // Some of ink's dependencies are still CommonJS and call
      // `require("assert")`. In an ESM bundle esbuild replaces `require` with a
      // stub that throws, so the CLI died on startup; handing it a real one
      // built from this module's URL is the fix.
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  alias: {
    // Ink's DevTools hook, which a shipped CLI never uses. See the stub.
    "react-devtools-core": resolve(here, "devtools-stub.ts"),
  },
  // `--version` has to answer something, and a bundle cannot read its own
  // package.json once installed elsewhere.
  define: { __TUI_VERSION__: JSON.stringify(version) },
  logLevel: "info",
  metafile: true,
});

// The shebang is only useful if the file is executable.
await chmod(outfile, 0o755);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built ${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
