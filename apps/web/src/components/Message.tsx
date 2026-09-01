import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ToolCallView, Trace, Turn } from "../lib/types.js";

export function Message({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-white">
          <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {turn.thinking && <Thinking text={turn.thinking} streaming={turn.streaming} />}

      {turn.steps?.map((step) => (
        <div key={step.iteration} className="space-y-1.5">
          {step.notes && <StepNotes text={step.notes} />}
          {step.calls.map((call) => (
            <ToolCall key={call.id} call={call} />
          ))}
        </div>
      ))}

      {turn.text && (
        <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
          <Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>
        </div>
      )}

      {turn.streaming && !turn.text && !turn.thinking && (
        <div className="flex gap-1 py-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-neutral-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      )}

      {turn.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {turn.error}
        </p>
      )}

      {turn.trace && <TraceBar trace={turn.trace} />}
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        <span>{streaming ? "Thinking…" : "Thought process"}</span>
        {!open && (
          <span className="truncate font-normal text-neutral-400">
            {text.slice(-70)}
          </span>
        )}
      </button>
      {open && (
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 pb-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Visible text a step produced before its tool call — not part of the reply, kept for inspection. */
function StepNotes({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        <span>Notes</span>
        {!open && <span className="truncate font-normal text-neutral-400">{text.slice(0, 70)}</span>}
      </button>
      {open && (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap px-3 pb-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          {text}
        </pre>
      )}
    </div>
  );
}

function ToolCall({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const pending = call.output === undefined;

  return (
    <div
      className={`rounded-lg border text-xs ${
        call.isError
          ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        <span className="font-mono font-medium">{call.name}</span>
        <span className="truncate text-neutral-400">{preview(call.input)}</span>
        <span className="ml-auto shrink-0">
          {pending ? (
            <span className="animate-pulse text-neutral-400">running…</span>
          ) : call.isError ? (
            <span className="text-red-600 dark:text-red-400">failed</span>
          ) : (
            <span className="text-green-600 dark:text-green-400">done</span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <Labelled label="input">{JSON.stringify(call.input, null, 2)}</Labelled>
          {call.output !== undefined && <Labelled label="output">{call.output}</Labelled>}
        </div>
      )}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">{label}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-neutral-100 p-2 font-mono text-[11px] dark:bg-neutral-800">
        {children}
      </pre>
    </div>
  );
}

function TraceBar({ trace }: { trace: Trace }) {
  const stopped = trace.stopReason !== "end_turn";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400">
      <span className="font-mono">{trace.model}</span>
      <span>{trace.iterations} iter</span>
      <span>
        {trace.inputTokens}↑ {trace.outputTokens}↓ tok
      </span>
      <span>{(trace.latencyMs / 1000).toFixed(1)}s</span>
      <span className={stopped ? "text-amber-600 dark:text-amber-400" : ""}>
        {trace.stopReason}
      </span>
    </div>
  );
}

function preview(input: unknown): string {
  const text = JSON.stringify(input) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
