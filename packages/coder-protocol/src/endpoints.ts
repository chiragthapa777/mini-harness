import { PassThrough } from "node:stream";
import type { z } from "zod";
import { Connection, RpcError } from "./connection.js";
import {
  CommandParams,
  CoreEvent,
  InitializeParams,
  PermissionResult,
  PROTOCOL_VERSION,
  SubmitParams,
  type CommandResult,
  type InitializeResult,
  type PermissionParams,
} from "./messages.js";

/** Validates a message from the other side, or fails the request with "invalid params". */
function check<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new RpcError(`invalid params: ${issue?.path.join(".")} ${issue?.message}`, -32602);
}

/** What the core does for each UI request. */
export interface CoreHandlers {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  submit(params: SubmitParams): void;
  abort(): void;
  command(params: CommandParams): Promise<CommandResult>;
  shutdown(): Promise<void>;
}

/** The core's side of the protocol. */
export class CoreEndpoint {
  constructor(readonly connection: Connection) {}

  handle(handlers: CoreHandlers): void {
    const c = this.connection;
    c.on("initialize", (params) => {
      const p = check(InitializeParams, params);
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(`protocol version mismatch: UI ${p.protocolVersion}, core ${PROTOCOL_VERSION}`);
      }
      return handlers.initialize(p);
    });
    c.on("submit", (params) => handlers.submit(check(SubmitParams, params)));
    c.on("abort", () => handlers.abort());
    c.on("command", (params) => handlers.command(check(CommandParams, params)));
    c.on("shutdown", () => handlers.shutdown());
  }

  event(event: CoreEvent): void {
    this.connection.notify("event", event);
  }

  async askPermission(params: PermissionParams, signal?: AbortSignal): Promise<PermissionResult> {
    const answer = await this.connection.request("permission", params, signal);
    return check(PermissionResult, answer);
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }
}

/** The UI's side of the protocol. */
export class UiEndpoint {
  constructor(readonly connection: Connection) {}

  initialize(params: Omit<InitializeParams, "protocolVersion">): Promise<InitializeResult> {
    return this.call("initialize", { ...params, protocolVersion: PROTOCOL_VERSION });
  }

  submit(text: string): Promise<void> {
    return this.call("submit", { text });
  }

  abort(): Promise<void> {
    return this.call("abort", {});
  }

  command(name: CommandParams["name"], arg?: string): Promise<CommandResult> {
    return this.call("command", { name, arg });
  }

  shutdown(): Promise<void> {
    return this.call("shutdown", {});
  }

  /** Events the UI does not know (from a newer core) are skipped. */
  onEvent(listener: (event: CoreEvent) => void): void {
    this.connection.on("event", (raw) => {
      const result = CoreEvent.safeParse(raw);
      if (result.success) listener(result.data);
    });
  }

  onPermission(handler: (params: PermissionParams) => PermissionResult | Promise<PermissionResult>): void {
    this.connection.on("permission", (params) => handler(params as PermissionParams));
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    return this.connection.request(method, params) as Promise<T>;
  }
}

/** Two connected endpoints over in-memory streams, for tests. */
export function memoryConnections() {
  const toCore = new PassThrough();
  const toUi = new PassThrough();
  return {
    ui: new Connection(toUi, toCore),
    core: new Connection(toCore, toUi),
    close() {
      toCore.end();
      toUi.end();
    },
  };
}
