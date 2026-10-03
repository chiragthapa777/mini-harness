import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Connection, CoreEndpoint, PROTOCOL_VERSION, UiEndpoint, memoryConnections, type CoreEvent } from "../src/index.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function connect() {
  const wires = memoryConnections();
  const core = new CoreEndpoint(wires.core);
  const ui = new UiEndpoint(wires.ui);
  const submitted: string[] = [];

  core.handle({
    initialize: async (p) => ({ protocolVersion: PROTOCOL_VERSION, sessionId: "s1", model: p.model ?? "m", mode: "default" }),
    submit: (p) => void submitted.push(p.text),
    abort: () => {},
    command: async (p) => ({ message: `ran ${p.name}` }),
    shutdown: async () => {},
  });

  return { wires, core, ui, submitted };
}

test("UI requests reach the core and get answers", async () => {
  const { ui, submitted } = connect();
  assert.equal((await ui.initialize({ cwd: "/repo" })).sessionId, "s1");
  await ui.submit("hello");
  assert.deepEqual(submitted, ["hello"]);
  assert.deepEqual(await ui.command("undo"), { message: "ran undo" });
});

test("a different protocol version is refused", async () => {
  const { wires } = connect();
  await assert.rejects(
    wires.ui.request("initialize", { protocolVersion: PROTOCOL_VERSION + 1, cwd: "/repo" }),
    /protocol version mismatch/,
  );
});

test("invalid params are refused before the core sees them", async () => {
  const { wires, submitted } = connect();
  await assert.rejects(wires.ui.request("submit", { text: "" }), { code: -32602 });
  await assert.rejects(wires.ui.request("nope", {}), { code: -32601 });
  assert.deepEqual(submitted, []);
});

test("events reach the UI; unknown ones are skipped", async () => {
  const { wires, core, ui } = connect();
  const seen: CoreEvent[] = [];
  ui.onEvent((e) => seen.push(e));

  core.event({ type: "turn_start" });
  wires.core.notify("event", { type: "from_a_newer_core" });
  core.event({ type: "turn_end", stopReason: "end_turn" });
  await tick();

  assert.deepEqual(seen, [{ type: "turn_start" }, { type: "turn_end", stopReason: "end_turn" }]);
});

test("permission is a core → UI request", async () => {
  const { core, ui } = connect();
  ui.onPermission((p) => ({ decision: p.tool === "bash" ? "deny" : "allow" }));

  const params = { callId: "c1", tool: "bash", input: {}, reason: "commands ask" };
  assert.deepEqual(await core.askPermission(params), { decision: "deny" });
});

test("an aborted permission request stops waiting", async () => {
  const { core, ui } = connect();
  ui.onPermission(() => new Promise(() => {})); // the user never answers

  const controller = new AbortController();
  const asking = core.askPermission({ callId: "c1", tool: "bash", input: {}, reason: "r" }, controller.signal);
  controller.abort(new Error("Esc"));
  await assert.rejects(asking, /Esc/);
});

test("messages split across chunks are put back together", async () => {
  const input = new PassThrough();
  const ui = new UiEndpoint(new Connection(input, new PassThrough()));
  const seen: CoreEvent[] = [];
  ui.onEvent((e) => seen.push(e));

  const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "text_delta", text: "héllo" } });
  input.write(line.slice(0, 10));
  input.write(line.slice(10, 30));
  input.write(line.slice(30) + "\n");
  await tick();

  assert.deepEqual(seen, [{ type: "text_delta", text: "héllo" }]);
});

test("closing the connection rejects waiting requests", async () => {
  const { wires, core, ui } = connect();
  ui.onPermission(() => new Promise(() => {}));
  let closed = false;
  ui.onClose(() => (closed = true));

  const asking = core.askPermission({ callId: "c1", tool: "bash", input: {}, reason: "r" });
  await tick();
  wires.close();

  await assert.rejects(asking, /connection closed/);
  assert.equal(closed, true);
});
