import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeOpenRouter, within } from "./helpers.js";

/**
 * `mini-coder -p` as a real process: the UI spawns the core itself, so these
 * cover the pair — the reply on stdout, and either side dying ending both.
 */

const main = join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");

async function runHeadless(args: string[], modelUrl: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "coder-headless-")));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), main, ...args], {
    cwd: dir,
    // HOME keeps the core's log out of the real ~/.mini-coder.
    env: { ...process.env, HOME: dir, OPENROUTER_API_KEY: "test-key", OPENROUTER_BASE_URL: modelUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, dir, exited, stdout: () => stdout, stderr: () => stderr };
}

/** A model that accepts the request and never answers, so the turn stays open. */
async function hangingModel() {
  let called = () => {};
  const firstCall = new Promise<void>((resolve) => (called = resolve));
  const server = createServer(() => called());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    firstCall,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function corePidOf(uiPid: number): number {
  return Number(execFileSync("pgrep", ["-P", String(uiPid)], { encoding: "utf8" }).trim());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("-p prints the reply, denies the permission prompt, and exits 0", async () => {
  const model = await fakeOpenRouter([
    'Checking.\n```tool_call\n{"tool": "bash", "input": {"command": "echo from-bash"}}\n```',
    "Bash was denied.",
  ]);
  const ui = await runHeadless(["-p", "run echo"], model.url);

  try {
    assert.equal(await within(ui.exited, 30_000, "exit"), 0, ui.stderr());
    assert.equal(ui.stdout(), "Checking.\nBash was denied.\n");
    assert.match(model.bodies[1]!.messages.at(-1)!.content, /the user denied this call/);
    assert.equal((await readdir(join(ui.dir, ".mini-coder/logs"))).length, 1);
  } finally {
    ui.child.kill("SIGKILL");
    model.close();
  }
});

test("--mode bypass lets the tool run without a prompt", async () => {
  const model = await fakeOpenRouter([
    '```tool_call\n{"tool": "bash", "input": {"command": "echo from-bash"}}\n```',
    "Done.",
  ]);
  const ui = await runHeadless(["-p", "run echo", "--mode", "bypass"], model.url);

  try {
    assert.equal(await within(ui.exited, 30_000, "exit"), 0, ui.stderr());
    assert.match(model.bodies[1]!.messages.at(-1)!.content, /bash result:\nfrom-bash/);
  } finally {
    ui.child.kill("SIGKILL");
    model.close();
  }
});

test("killing the UI ends the core", async () => {
  const model = await hangingModel();
  const ui = await runHeadless(["-p", "hang"], model.url);

  try {
    await within(model.firstCall, 30_000, "the model call");
    const corePid = corePidOf(ui.child.pid!);
    ui.child.kill("SIGKILL");

    const gone = (async () => {
      while (isAlive(corePid)) await new Promise((resolve) => setTimeout(resolve, 50));
    })();
    await within(gone, 10_000, "the core exiting");
  } finally {
    ui.child.kill("SIGKILL");
    model.close();
  }
});

test("the core dying ends the UI with a non-zero exit", async () => {
  const model = await hangingModel();
  const ui = await runHeadless(["-p", "hang"], model.url);

  try {
    await within(model.firstCall, 30_000, "the model call");
    process.kill(corePidOf(ui.child.pid!), "SIGKILL");

    assert.equal(await within(ui.exited, 10_000, "exit"), 1);
    assert.match(ui.stderr(), /the core exited unexpectedly \(signal SIGKILL\)/);
  } finally {
    ui.child.kill("SIGKILL");
    model.close();
  }
});

test("Ctrl+C (SIGINT) on the UI shuts the core down and exits 130", async () => {
  const model = await hangingModel();
  const ui = await runHeadless(["-p", "hang"], model.url);

  try {
    await within(model.firstCall, 30_000, "the model call");
    const corePid = corePidOf(ui.child.pid!);
    ui.child.kill("SIGINT");

    assert.equal(await within(ui.exited, 10_000, "exit"), 130);
    assert.equal(isAlive(corePid), false);
  } finally {
    ui.child.kill("SIGKILL");
    model.close();
  }
});
