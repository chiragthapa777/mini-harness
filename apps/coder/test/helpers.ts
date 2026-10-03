import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Streams each scripted reply as OpenAI chat-completion chunks, in order. */
export async function fakeOpenRouter(replies: string[]) {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let index = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const reply = replies[Math.min(index++, replies.length - 1)] ?? "";
      const chunk = (choices: unknown[], extra: object = {}) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices, ...extra })}\n\n`;

      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < reply.length; i += 10) {
        res.write(chunk([{ index: 0, delta: { content: reply.slice(i, i + 10) }, finish_reason: null }]));
      }
      res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      res.write(chunk([], { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }));
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, bodies, close: () => server.close() };
}

export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms}ms`)), ms).unref()),
  ]);
}
