import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ChatMenu } from "../components/ChatMenu.js";
import { Composer } from "../components/Composer.js";
import { MenuButton } from "../components/Layout.js";
import { Message } from "../components/Message.js";
import { loadMessages, streamChat } from "../lib/api.js";
import type { LayoutContext, ToolCallView, Turn } from "../lib/types.js";

/**
 * The streaming path. Everything the harness does arrives as it happens:
 * reasoning tokens, iteration boundaries, tool calls and their results, the
 * answer itself, and finally the trace.
 */
export function ChatStream() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toggleSidebar } = useOutletContext<LayoutContext>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const abort = useRef<AbortController>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // A new conversation navigates to its own URL mid-run. Without this, the
  // loader below would fire on that id change and wipe the live turns.
  const ownNavigation = useRef<string>(null);

  useEffect(() => {
    if (!id) {
      setTurns([]);
      return;
    }
    if (ownNavigation.current === id) {
      ownNavigation.current = null;
      return;
    }
    void loadMessages(id).then((messages) =>
      setTurns(
        messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as Turn["role"], text: m.content })),
      ),
    );
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  // Abort an in-flight run if the user navigates away mid-stream.
  useEffect(() => () => abort.current?.abort(), []);

  /** Mutates the assistant turn currently being streamed (always the last). */
  const patch = useCallback((fn: (turn: Turn) => Turn) => {
    setTurns((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      if (last?.role === "assistant") next[next.length - 1] = fn(last);
      return next;
    });
  }, []);

  async function send(prompt: string) {
    const controller = new AbortController();
    abort.current = controller;

    setTurns((prev) => [
      ...prev,
      { role: "user", text: prompt },
      { role: "assistant", text: "", streaming: true, steps: [] },
    ]);
    setBusy(true);
    setStatus("connecting…");

    let iteration = 0;

    try {
      for await (const event of streamChat(prompt, id, controller.signal)) {
        switch (event.type) {
          case "conversation":
            if (!id) {
              ownNavigation.current = event.conversationId;
              navigate(`/c/${event.conversationId}`, { replace: true });
            }
            break;

          case "run_start":
            setStatus(event.model);
            break;

          case "iteration_start":
            iteration = event.iteration;
            setStatus(`step ${event.iteration}`);
            patch((turn) => {
              // Only the final iteration's text becomes the reply (see
              // `loop.ts`) — text streamed before an earlier iteration's tool
              // call is leaked preamble, not part of the answer, so it must
              // not stick around to be glued onto it. It is still worth
              // keeping, though, so park it as a note on the step that
              // produced it instead of dropping it.
              const steps = turn.steps ?? [];
              const withNote =
                turn.text && steps.length > 0
                  ? steps.map((s, i) => (i === steps.length - 1 ? { ...s, notes: turn.text } : s))
                  : steps;
              return {
                ...turn,
                text: "",
                steps: [...withNote, { iteration: event.iteration, calls: [] }],
              };
            });
            break;

          case "thinking_delta":
            patch((turn) => ({ ...turn, thinking: (turn.thinking ?? "") + event.text }));
            break;

          case "text_delta":
            patch((turn) => ({ ...turn, text: turn.text + event.text }));
            break;

          case "tool_call": {
            // React runs the updater at render time, by which point the loop
            // has moved on — so bind the step number now, not inside it.
            const step = iteration;
            setStatus(`calling ${event.name}`);
            patch((turn) => ({
              ...turn,
              steps: updateStep(turn, step, (calls) => [
                ...calls,
                { id: event.id, name: event.name, input: event.input },
              ]),
            }));
            break;
          }

          case "tool_result": {
            const step = iteration;
            patch((turn) => ({
              ...turn,
              steps: updateStep(turn, step, (calls) =>
                calls.map((call) =>
                  call.id === event.id
                    ? { ...call, output: event.output, isError: event.isError }
                    : call,
                ),
              ),
            }));
            break;
          }

          case "guardrail":
            patch((turn) => ({ ...turn, error: `stopped by guardrail: ${event.reason}` }));
            break;

          // The streamed text is authoritative; `reply` only fills the gap when
          // a run produced no visible deltas at all.
          case "reply":
            patch((turn) => ({ ...turn, text: turn.text || event.text }));
            break;

          case "trace":
            patch((turn) => ({ ...turn, trace: event.trace, streaming: false }));
            break;

          case "error":
            patch((turn) => ({ ...turn, error: event.message, streaming: false }));
            break;

          case "done":
            patch((turn) => ({ ...turn, streaming: false }));
            break;
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      patch((turn) => ({
        ...turn,
        streaming: false,
        error: aborted ? "stopped" : err instanceof Error ? err.message : "stream failed",
      }));
    } finally {
      setBusy(false);
      setStatus("");
      abort.current = null;
    }
  }

  return (
    <>
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 text-sm font-medium sm:px-6 dark:border-neutral-800">
        <MenuButton onClick={toggleSidebar} />
        Streaming
        <span className="hidden text-xs font-normal text-neutral-400 sm:inline">
          thinking, tools, and text as they happen
        </span>
        {status && (
          <span className="ml-auto animate-pulse font-mono text-xs text-neutral-400">
            {status}
          </span>
        )}
        <ChatMenu mode="stream" conversationId={id} />
      </header>

      {turns.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
          <h1 className="font-serif text-3xl text-neutral-700 sm:text-4xl dark:text-neutral-300">
            What can I help with?
          </h1>
          <div className="w-full max-w-2xl">
            <Composer
              busy={busy}
              onSend={(p) => void send(p)}
              onStop={() => abort.current?.abort()}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-5 overflow-y-auto px-3 py-6 sm:px-6">
            {turns.map((turn, i) => (
              <Message key={i} turn={turn} />
            ))}
            <div ref={bottom} />
          </div>

          <div className="border-t border-neutral-200 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 dark:border-neutral-800">
            <Composer
              busy={busy}
              onSend={(p) => void send(p)}
              onStop={() => abort.current?.abort()}
            />
          </div>
        </>
      )}
    </>
  );
}

function updateStep(
  turn: Turn,
  iteration: number,
  fn: (calls: ToolCallView[]) => ToolCallView[],
): Turn["steps"] {
  const steps = turn.steps ?? [];
  return steps.map((step) =>
    step.iteration === iteration ? { ...step, calls: fn(step.calls) } : step,
  );
}
