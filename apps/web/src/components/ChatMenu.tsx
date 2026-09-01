import { useState } from "react";
import { Link } from "react-router-dom";

type Mode = "classic" | "stream";

/**
 * Per-conversation settings, anchored top-right of the chat header. Response
 * mode lives here today; more conversation-scoped settings land in this same
 * menu rather than growing new header controls.
 */
export function ChatMenu({ mode, conversationId }: { mode: Mode; conversationId?: string }) {
  const [open, setOpen] = useState(false);
  const classicHref = conversationId ? `/c/${conversationId}?mode=classic` : "/?mode=classic";
  const streamHref = conversationId ? `/c/${conversationId}` : "/";

  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Conversation settings"
        className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30"
          />
          <div className="absolute right-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
            <p className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
              Response mode
            </p>
            <ModeOption to={classicHref} active={mode === "classic"} onSelect={() => setOpen(false)}>
              Classic
              <span className="block text-[11px] font-normal text-neutral-400">
                waits for the full reply
              </span>
            </ModeOption>
            <ModeOption to={streamHref} active={mode === "stream"} onSelect={() => setOpen(false)}>
              Streaming
              <span className="block text-[11px] font-normal text-neutral-400">
                thinking, tools, and text as they happen
              </span>
            </ModeOption>
          </div>
        </>
      )}
    </div>
  );
}

function ModeOption({
  to,
  active,
  onSelect,
  children,
}: {
  to: string;
  active: boolean;
  onSelect(): void;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      onClick={onSelect}
      className={`flex items-start justify-between gap-2 px-3 py-2 text-sm ${
        active ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      <span className={active ? "font-medium" : ""}>{children}</span>
      {active && (
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </Link>
  );
}
