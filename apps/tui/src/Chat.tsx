import { Box, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import { streamChat, type AuthUser } from "./api.js";
import { Markdown } from "./Markdown.js";
import { clearToken } from "./token.js";

interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Tool calls the agent made while producing this turn. */
  tools?: { name: string; isError?: boolean }[];
}

/**
 * The chat surface. It streams the same SSE the browser does and renders the
 * same three things: tool calls as they run, markdown-rendered text as it
 * arrives, and a trace line when the turn ends. Thinking deltas are collected but not printed —
 * a terminal has no collapsible panel, and reasoning would bury the answer.
 */
export function Chat({ token, user }: { token: string; user: AuthUser }) {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  async function send(prompt: string) {
    setTurns((prev) => [...prev, { role: "user", text: prompt }, { role: "assistant", text: "" }]);
    setStreaming(true);
    setError(null);
    setStatus("thinking…");

    const controller = new AbortController();
    abort.current = controller;

    // Every event updates the last turn in place, which is what makes the
    // reply appear to type itself rather than arriving in one block.
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? fn(turn) : turn)));

    try {
      for await (const event of streamChat(token, prompt, conversationId.current, controller.signal)) {
        switch (event.type) {
          case "conversation":
            conversationId.current = event.conversationId;
            break;
          case "tool_call":
            setStatus(`${event.name}…`);
            patch((turn) => ({ ...turn, tools: [...(turn.tools ?? []), { name: event.name }] }));
            break;
          case "tool_result":
            patch((turn) => ({
              ...turn,
              tools: (turn.tools ?? []).map((tool) =>
                tool.name === event.name && tool.isError === undefined
                  ? { ...tool, isError: event.isError }
                  : tool,
              ),
            }));
            break;
          case "text_delta":
            setStatus(null);
            patch((turn) => ({ ...turn, text: turn.text + event.text }));
            break;
          case "reply":
            // The loop keeps only the last iteration's text; trust it over the
            // deltas, which may include text from an iteration that tool-called.
            patch((turn) => ({ ...turn, text: event.text }));
            break;
          case "guardrail":
            setStatus(`stopped: ${event.reason}`);
            break;
          case "trace":
            setStatus(
              `${event.trace.iterations} iteration(s) · ${event.trace.inputTokens}↑ ${event.trace.outputTokens}↓ tokens`,
            );
            break;
          case "error":
            setError(event.message);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "the run failed");
      }
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }

  useInput((value, key) => {
    if (key.escape && streaming) {
      // Abandoning the stream stops the tokens arriving here; the run itself
      // ends when the server notices the response closed.
      abort.current?.abort();
      setStatus("cancelled");
      return;
    }
    if (streaming) return;

    if (key.return) {
      const prompt = input.trim();
      if (!prompt) return;
      if (prompt === "/quit" || prompt === "/exit") {
        exit();
        return;
      }
      if (prompt === "/logout") {
        void clearToken().then(exit);
        return;
      }
      if (prompt === "/new") {
        conversationId.current = undefined;
        setTurns([]);
        setStatus("new conversation");
        setInput("");
        return;
      }
      setInput("");
      void send(prompt);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (value && !key.ctrl && !key.meta) setInput((current) => current + value);
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text bold>mini-agent</Text>
        <Text dimColor> · {user.email} · /new /logout /quit</Text>
      </Box>

      {turns.map((turn, index) => (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color={turn.role === "user" ? "cyan" : "green"}>
            {turn.role === "user" ? "you" : "agent"}
          </Text>
          {turn.tools?.map((tool, toolIndex) => (
            <Text key={toolIndex} dimColor>
              {tool.isError === undefined ? "•" : tool.isError ? "✗" : "✓"} {tool.name}
            </Text>
          ))}
          {/* The agent writes markdown because the web app renders it; showing
              it raw here meant reading literal asterisks and fences. What the
              user typed is left exactly as typed. */}
          {turn.role === "assistant" ? <Markdown>{turn.text}</Markdown> : <Text>{turn.text}</Text>}
        </Box>
      ))}

      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1}>
        {streaming ? (
          <Text dimColor>{status ?? "working…"} (esc to cancel)</Text>
        ) : (
          <>
            <Text color="cyan">› </Text>
            <Text>{input}</Text>
            <Text color="cyan">▌</Text>
          </>
        )}
      </Box>
      {!streaming && status && <Text dimColor>{status}</Text>}
    </Box>
  );
}
