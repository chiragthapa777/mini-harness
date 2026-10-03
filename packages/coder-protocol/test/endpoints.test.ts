import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode } from "../src/connection.js";
import { CoreEndpoint, UiEndpoint, memoryConnections, type CoreHandlers } from "../src/endpoints.js";
import { EVENT_METHOD, PROTOCOL_VERSION, type CoreEvent } from "../src/messages.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function pair(overrides: Partial<CoreHandlers> = {}) {
  const wires = memoryConnections();
  const core = new CoreEndpoint(wires.core);
  const ui = new UiEndpoint(wires.ui);
  const received: unknown[] = [];

  core.handle({
    initialize: (params) => ({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: "s1",
      model: params.model ?? "openrouter:default",
      mode: params.mode ?? "default",
    }),
    submit: (params) => {
      received.push(params);
      return {};
    },
    abort: () => ({}),
    command: (params) => ({ message: `ran ${params.name}` }),
    shutdown: () => ({}),
    ...overrides,
  });

  return { core, ui, received, wires };
}

test("initialize fills in the protocol version and returns the session", async () => {
  const { ui } = pair();
  const result = await ui.initialize({ cwd: "/repo", mode: "plan" });
  assert.deepEqual(result, {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "s1",
    model: "openrouter:default",
    mode: "plan",
  });
});

test("initialize rejects a UI built for another protocol version", async () => {
  const { ui } = pair();
  await assert.rejects(
    ui.request("initialize", { protocolVersion: PROTOCOL_VERSION + 1, cwd: "/repo" }),
    (err: { code: number; message: string }) =>
      err.code === ErrorCode.Rejected && /version mismatch/.test(err.message),
  );
});

test("invalid params never reach a core handler", async () => {
  const { ui, received } = pair();
  await assert.rejects(
    ui.request("submit", { text: "" } as never),
    (err: { code: number; message: string }) =>
      err.code === ErrorCode.InvalidParams && /submit params: text/.test(err.message),
  );
  await assert.rejects(ui.request("command", { name: "format-disk" } as never), {
    code: ErrorCode.InvalidParams,
  });
  assert.deepEqual(received, []);
});

test("events reach every listener; unknown or malformed events are skipped", async () => {
  const { core, ui, wires } = pair();
  const seen: CoreEvent[] = [];
  const unsubscribe = ui.onEvent((event) => seen.push(event));

  core.event({ type: "turn_start" });
  // From a newer core: a type this UI has never heard of.
  wires.core.notify(EVENT_METHOD, { type: "sparkles", amount: 3 });
  // Malformed: a known type missing its field.
  wires.core.notify(EVENT_METHOD, { type: "text_delta" });
  core.event({ type: "text_delta", text: "hello" });
  core.event({ type: "turn_end", stopReason: "end_turn" });
  await tick();

  assert.deepEqual(seen, [
    { type: "turn_start" },
    { type: "text_delta", text: "hello" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);

  unsubscribe();
  core.event({ type: "turn_start" });
  await tick();
  assert.equal(seen.length, 3);
});

test("permission is a core → UI request answered by the UI", async () => {
  const { core, ui } = pair();
  const asked: unknown[] = [];
  ui.onPermission((params) => {
    asked.push(params);
    return { decision: "always" };
  });

  const answer = await core.askPermission({
    callId: "call_1",
    tool: "bash",
    input: { command: "rm -rf build" },
    reason: "bash asks by default",
  });

  assert.deepEqual(answer, { decision: "always" });
  assert.deepEqual(asked, [
    { callId: "call_1", tool: "bash", input: { command: "rm -rf build" }, reason: "bash asks by default" },
  ]);
});

test("a UI answer outside the schema is rejected on the core side", async () => {
  const { core, ui } = pair();
  ui.onPermission(() => ({ decision: "maybe" }) as never);

  await assert.rejects(
    core.askPermission({ callId: "c", tool: "bash", input: {}, reason: "r" }),
    { code: ErrorCode.InvalidParams },
  );
});

test("an aborted permission request stops waiting", async () => {
  const { core, ui } = pair();
  ui.onPermission(() => new Promise(() => {})); // the user never answers

  const controller = new AbortController();
  const pending = core.askPermission(
    { callId: "c", tool: "edit_file", input: {}, reason: "r" },
    controller.signal,
  );
  controller.abort(new Error("aborted"));
  await assert.rejects(pending, { message: "aborted" });
});
