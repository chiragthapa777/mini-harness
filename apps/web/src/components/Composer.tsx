import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface Props {
  busy: boolean;
  onSend(prompt: string): void;
  onStop?(): void;
  placeholder?: string;
}

export function Composer({ busy, onSend, onStop, placeholder }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content instead of scrolling a one-line box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt || busy) return;
    setValue("");
    onSend(prompt);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "Send a message…  (Enter to send, Shift+Enter for a new line)"}
        className="flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {busy && onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-xl border border-neutral-300 px-4 py-3 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      )}
    </form>
  );
}
