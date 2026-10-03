import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Connection, ConnectionClosedError, ErrorCode, RpcError } from "../src/connection.js";
import { memoryConnections } from "../src/endpoints.js";

/** A connection whose raw wire is visible: write lines in, read lines out. */
function rawPeer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new Connection(input, output);
  const lines: unknown[] = [];
  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part) lines.push(JSON.parse(part));
  });
  return { connection, input, lines };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a request round-trips in both directions", async () => {
  const { ui, core } = memoryConnections();
  core.onRequest("add", (params) => {
    const { a, b } = params as { a: number; b: number };
    return { sum: a + b };
  });
  ui.onRequest("greet", (params) => ({ text: `hi ${(params as { name: string }).name}` }));

  assert.deepEqual(await ui.request("add", { a: 2, b: 3 }), { sum: 5 });
  assert.deepEqual(await core.request("greet", { name: "ui" }), { text: "hi ui" });
});

test("notifications arrive in order and get no reply", async () => {
  const { ui, core } = memoryConnections();
  const seen: unknown[] = [];
  ui.onNotification("event", (params) => seen.push(params));

  for (let i = 0; i < 5; i++) core.notify("event", { i });
  await tick();

  assert.deepEqual(seen, [0, 1, 2, 3, 4].map((i) => ({ i })));
});

test("a handler's RpcError reaches the caller with its code", async () => {
  const { ui, core } = memoryConnections();
  core.onRequest("busy", () => {
    throw new RpcError(ErrorCode.Rejected, "a turn is already running");
  });
  core.onRequest("crash", () => {
    throw new Error("boom");
  });

  await assert.rejects(ui.request("busy", {}), (err: unknown) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.code, ErrorCode.Rejected);
    assert.equal(err.message, "a turn is already running");
    return true;
  });
  await assert.rejects(ui.request("crash", {}), { code: ErrorCode.InternalError, message: "boom" });
  await assert.rejects(ui.request("nope", {}), { code: ErrorCode.MethodNotFound });
});

test("messages split across chunks are reassembled at the newline", async () => {
  const { connection, input } = rawPeer();
  const seen: unknown[] = [];
  connection.onNotification("event", (params) => seen.push(params));

  const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { text: "héllo" } });
  input.write(line.slice(0, 10));
  input.write(line.slice(10, 30));
  await tick();
  assert.deepEqual(seen, []);

  input.write(`${line.slice(30)}\n`);
  await tick();
  assert.deepEqual(seen, [{ text: "héllo" }]);
});

test("invalid JSON gets a parse error and the connection keeps working", async () => {
  const { connection, input, lines } = rawPeer();
  connection.onRequest("ping", () => ({ pong: true }));

  input.write("{not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
  await tick();
  await tick();

  assert.deepEqual(lines, [
    { jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "invalid JSON" } },
    { jsonrpc: "2.0", id: 7, result: { pong: true } },
  ]);
});

test("aborting a request rejects it and drops the late answer", async () => {
  const { ui, core } = memoryConnections();
  let answer: (value: unknown) => void = () => {};
  core.onRequest("slow", () => new Promise((resolve) => (answer = resolve)));

  const controller = new AbortController();
  const pending = ui.request("slow", {}, controller.signal);
  await tick();
  controller.abort(new Error("user pressed Esc"));
  await assert.rejects(pending, { message: "user pressed Esc" });

  // The peer still answers; nothing must blow up and nothing is delivered.
  answer({ late: true });
  await tick();
  core.onRequest("ok", () => "fine");
  assert.equal(await ui.request("ok", {}), "fine");
});

test("closing the stream rejects pending requests and fires close listeners", async () => {
  const { ui, core, close } = memoryConnections();
  core.onRequest("never", () => new Promise(() => {}));

  let closed = 0;
  ui.onClose(() => closed++);
  const pending = ui.request("never", {});
  await tick();
  close();

  await assert.rejects(pending, ConnectionClosedError);
  assert.equal(closed, 1);
  assert.equal(ui.closed, true);
  await assert.rejects(ui.request("after", {}), ConnectionClosedError);
});
