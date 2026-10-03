import { PassThrough } from "node:stream";
import type { z } from "zod";
import { Connection, ErrorCode, RpcError } from "./connection.js";
import {
  EVENT_METHOD,
  PROTOCOL_VERSION,
  coreRequests,
  parseEvent,
  uiRequests,
  type CoreEvent,
  type CoreRequests,
  type UiRequests,
} from "./messages.js";

/**
 * The typed halves of the protocol. The core holds a `CoreEndpoint`, a UI
 * holds a `UiEndpoint`; both wrap the same untyped `Connection`. Everything
 * arriving from the other side is validated here, so neither side's code
 * ever sees a message that does not match the schema.
 */

type Awaitable<T> = T | Promise<T>;

export type CoreHandlers = {
  [M in keyof UiRequests]: (params: UiRequests[M]["params"]) => Awaitable<UiRequests[M]["result"]>;
};

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RpcError(ErrorCode.InvalidParams, `invalid ${what}: ${detail}`);
  }
  return result.data;
}

export class CoreEndpoint {
  readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /** Registers the core's request handlers. Params are validated before a handler sees them. */
  handle(handlers: CoreHandlers): void {
    for (const method of Object.keys(uiRequests) as (keyof UiRequests)[]) {
      const { params: schema } = uiRequests[method];
      const handler = handlers[method] as (params: unknown) => unknown;

      this.connection.onRequest(method, (raw) => {
        const params = parse(schema, raw, `${method} params`);
        if (method === "initialize") {
          const { protocolVersion } = params as UiRequests["initialize"]["params"];
          if (protocolVersion !== PROTOCOL_VERSION) {
            throw new RpcError(
              ErrorCode.Rejected,
              `protocol version mismatch: UI speaks ${protocolVersion}, core speaks ${PROTOCOL_VERSION}`,
            );
          }
        }
        return handler(params);
      });
    }
  }

  event(event: CoreEvent): void {
    this.connection.notify(EVENT_METHOD, event);
  }

  /** Asks the UI to approve a tool call. Aborting `signal` stops waiting; a late answer is dropped. */
  async askPermission(
    params: CoreRequests["permission"]["params"],
    signal?: AbortSignal,
  ): Promise<CoreRequests["permission"]["result"]> {
    const result = await this.connection.request("permission", params, signal);
    return parse(coreRequests.permission.result, result, "permission result");
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }
}

export class UiEndpoint {
  readonly connection: Connection;
  readonly #listeners = new Set<(event: CoreEvent) => void>();

  constructor(connection: Connection) {
    this.connection = connection;
    connection.onNotification(EVENT_METHOD, (raw) => {
      // Unknown or malformed events are skipped, never fatal.
      const event = parseEvent(raw);
      if (!event) return;
      for (const listener of this.#listeners) listener(event);
    });
  }

  async request<M extends keyof UiRequests>(
    method: M,
    params: UiRequests[M]["params"],
  ): Promise<UiRequests[M]["result"]> {
    const result = await this.connection.request(method, params);
    return parse(uiRequests[method].result, result, `${method} result`) as UiRequests[M]["result"];
  }

  /** `initialize` with this package's protocol version filled in. */
  initialize(
    params: Omit<UiRequests["initialize"]["params"], "protocolVersion">,
  ): Promise<UiRequests["initialize"]["result"]> {
    return this.request("initialize", { ...params, protocolVersion: PROTOCOL_VERSION });
  }

  /** Returns an unsubscribe function. */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onPermission(
    handler: (
      params: CoreRequests["permission"]["params"],
    ) => Awaitable<CoreRequests["permission"]["result"]>,
  ): void {
    this.connection.onRequest("permission", (raw) =>
      handler(parse(coreRequests.permission.params, raw, "permission params")),
    );
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }
}

/**
 * Two connections wired to each other through in-memory streams. Tests use
 * it to run a real core against a scripted UI, over the same code path the
 * stdio pipes take.
 */
export function memoryConnections(): { ui: Connection; core: Connection; close(): void } {
  const uiToCore = new PassThrough();
  const coreToUi = new PassThrough();
  return {
    ui: new Connection(coreToUi, uiToCore),
    core: new Connection(uiToCore, coreToUi),
    close() {
      uiToCore.end();
      coreToUi.end();
    },
  };
}
