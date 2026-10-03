import { runServe } from "./serve.js";

/**
 * Entry point of the `mini-coder` command. Today only the core process
 * exists; the UI that spawns it (and `-p`) arrive in phase 3.
 */
const [command] = process.argv.slice(2);

if (command === "serve") {
  runServe();
} else {
  console.error("usage: mini-coder serve    (runs the core over stdio; the UI arrives in phase 3)");
  process.exit(2);
}
