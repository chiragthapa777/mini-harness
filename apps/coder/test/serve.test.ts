import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Connection, UiEndpoint, type CoreEvent, type PermissionParams } from "@mini-agent/coder-protocol";
import { fakeOpenRouter, within } from "./helpers.js";

/**
 * The real core process, end to end: `mini-coder serve` spawned as a child,
 * driven over its stdio by a UiEndpoint, with OpenRouter pointed at a local
 * fake that speaks the OpenAI streaming format. Real adapter, real tools,
 * real process lifecycle — no network, no key.
 */

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function startCore(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "serve"], {
    cwd: appDir,
    env: { ...process.env, OPENROUTER_API_KEY: "test-key", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  let partial = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    stdoutLines.push(...lines.filter(Boolean));
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const ui = new UiEndpoint(new Connection(child.stdout, child.stdin));
  return { child, ui, exited, stdoutLines, stderr: () => stderr };
}

test("a turn through the real process: model → bash → permission → reply → shutdown", async () => {
  const model = await fakeOpenRouter([
    'Checking.\n```tool_call\n{"tool": "bash", "input": {"command": "echo from-bash"}}\n```',
    "The command printed from-bash.",
  ]);
  const core = startCore({ OPENROUTER_BASE_URL: model.url });
  const project = await realpath(await mkdtemp(join(tmpdir(), "coder-serve-")));

  try {
    const events: CoreEvent[] = [];
    const asked: PermissionParams[] = [];
    const ended = new Promise<void>((resolve) =>
      core.ui.onEvent((event) => {
        events.push(event);
        if (event.type === "turn_end") resolve();
      }),
    );
    core.ui.onPermission((params) => {
      asked.push(params);
      return { decision: "allow" };
    });

    const init = await within(core.ui.initialize({ cwd: project }), 15_000, "initialize");
    assert.equal(init.model, "openrouter:z-ai/glm-5.3-flash");

    await core.ui.submit("run echo");
    await within(ended, 15_000, "the turn");

    assert.deepEqual(
      events.filter((e) => e.type !== "text_delta" && e.type !== "usage").map((e) => e.type),
      ["turn_start", "tool_start", "tool_output", "tool_end", "turn_end"],
    );
    const toolEnd = events.find((e) => e.type === "tool_end");
    assert.deepEqual(toolEnd && { output: toolEnd.output, isError: toolEnd.isError }, {
      output: "from-bash\n",
      isError: false,
    });
    assert.deepEqual(events.at(-1), { type: "turn_end", stopReason: "end_turn" });
    assert.equal(
      events.map((e) => (e.type === "text_delta" ? e.text : "")).join(""),
      "Checking.\nThe command printed from-bash.",
    );
    assert.deepEqual(asked.map((a) => a.tool), ["bash"]);

    // The second model call carried the tool result back.
    assert.match(model.bodies[1]!.messages.at(-1)!.content, /\[call_1\] bash result:\nfrom-bash/);

    await core.ui.shutdown();
    assert.equal(await within(core.exited, 10_000, "exit"), 0);

    // stdout carried protocol messages and nothing else.
    for (const line of core.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), line);
  } finally {
    core.child.kill("SIGKILL");
    model.close();
  }
});

test("the core exits when the UI closes its stdin", async () => {
  const core = startCore();
  try {
    await within(core.ui.initialize({ cwd: tmpdir() }), 15_000, "initialize");
    core.child.stdin.end();
    assert.equal(await within(core.exited, 10_000, "exit"), 0);
  } finally {
    core.child.kill("SIGKILL");
  }
});

test("Ctrl+C (SIGINT) does not kill the core; the UI decides", async () => {
  const core = startCore();
  try {
    await within(core.ui.initialize({ cwd: tmpdir() }), 15_000, "initialize");
    core.child.kill("SIGINT");
    const reply = await within(core.ui.command("model"), 5_000, "command");
    assert.equal(reply.message, "model: openrouter:z-ai/glm-5.3-flash");
    await core.ui.shutdown();
    assert.equal(await within(core.exited, 10_000, "exit"), 0);
  } finally {
    core.child.kill("SIGKILL");
  }
});
