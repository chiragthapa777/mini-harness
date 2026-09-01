import type { Response } from "express";
import type { RunEvent } from "@mini-agent/core";

export type OutboundEvent =
  | RunEvent
  | { type: "conversation"; conversationId: string }
  | { type: "done" };

export function sendEvent(res: Response, event: OutboundEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
