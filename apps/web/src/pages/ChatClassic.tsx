import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Composer } from "../components/Composer.js";
import { Message } from "../components/Message.js";
import { loadMessages, sendChat } from "../lib/api.js";
import type { Turn } from "../lib/types.js";

/** The original non-streaming path: one request, one reply. */
export function ChatClassic() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  // Navigating to a freshly created conversation must not reload over the
  // turns we already have — that would drop the trace we just rendered.
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

  async function send(prompt: string) {
    setTurns((prev) => [...prev, { role: "user", text: prompt }]);
    setBusy(true);

    try {
      const result = await sendChat(prompt, id);
      setTurns((prev) => [
        ...prev,
        { role: "assistant", text: result.reply, trace: result.trace },
      ]);
      if (!id) {
        ownNavigation.current = result.conversationId;
        navigate(`/c/${result.conversationId}`, { replace: true });
      }
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "",
          error: err instanceof Error ? err.message : "request failed",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="border-b border-neutral-200 px-6 py-3 text-sm font-medium dark:border-neutral-800">
        Classic
        <span className="ml-2 text-xs font-normal text-neutral-400">
          waits for the full reply
        </span>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-6">
        {turns.length === 0 && (
          <p className="mt-20 text-center text-sm text-neutral-400">
            Ask something to start this conversation.
          </p>
        )}
        {turns.map((turn, i) => (
          <Message key={i} turn={turn} />
        ))}
        {busy && <p className="text-sm text-neutral-400">Thinking…</p>}
        <div ref={bottom} />
      </div>

      <div className="border-t border-neutral-200 px-6 py-4 dark:border-neutral-800">
        <Composer busy={busy} onSend={(p) => void send(p)} />
      </div>
    </>
  );
}
