import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles mini-coder into one executable file, `dist/mini-coder.mjs`: the UI
 * and the core are the same file, run twice. Needs Node 22+ on the machine.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "dist/mini-coder.mjs");

await build({
  entryPoints: [resolve(here, "src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // The provider SDKs pull in CommonJS that calls `require`, which esbuild
      // stubs out in an ESM bundle; give it a real one.
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

await chmod(outfile, 0o755);
