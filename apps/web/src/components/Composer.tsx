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

  // Grow with the content instead of scrolling a one-line box, but never past
  // a third of the viewport: 200px of composer on a phone with the keyboard up
  // leaves nothing of the conversation visible.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cap = Math.max(96, Math.min(200, Math.round(window.innerHeight * 0.3)));
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
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
    <form
      onSubmit={submit}
      // `min-w-0` matters inside the flex column above: without it a long
      // unbroken line in the textarea can push the form wider than the screen.
      className="min-w-0 rounded-2xl border border-neutral-300 bg-white focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-600"
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "How can I help you today?"}
        title={placeholder ?? "Send a message… (Enter to send, Shift+Enter for a new line)"}
        // Prose, not a name or a URL: sentence case is right, autocorrect is
        // welcome, and the keyboard's action key should say "return" rather
        // than "go", since Enter sends but Shift+Enter is a newline.
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        enterKeyHint="send"
        // 16px on phones so iOS does not zoom the page on focus; the smaller
        // desktop size returns at `sm`. The global rule in index.css covers
        // this too — this keeps it visible at the call site.
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none placeholder:text-neutral-400 sm:text-sm"
      />
      <div className="flex items-center justify-end px-3 pb-2.5">
        {busy && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-neutral-300 px-3.5 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
