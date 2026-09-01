import { useEffect, useState } from "react";
import {
  adminGetTrace,
  adminListTraces,
  type AdminTrace,
  type AdminTraceDetail,
  type AdminUser,
} from "../../lib/api.js";
import { Pager } from "./MemoryTab.js";

const inputClass =
  "rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900";

const LIMIT = 50;

/** LLM Ops — every run, filterable by user, model, error status, and date range. */
export function TracesTab({ users }: { users: AdminUser[] }) {
  const [userId, setUserId] = useState("");
  const [model, setModel] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [traces, setTraces] = useState<AdminTrace[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // A trace's model field is free text ("openrouter/gpt-4o"), so the filter
  // is a substring search — debounce it, or every keystroke fires a request.
  useEffect(() => {
    const id = setTimeout(() => setModelFilter(model), 300);
    return () => clearTimeout(id);
  }, [model]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    adminListTraces({
      userId: userId || undefined,
      model: modelFilter || undefined,
      errorOnly,
      from: from || undefined,
      to: to || undefined,
      limit: LIMIT,
      offset,
    })
      .then((res) => {
        setTraces(res.traces);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load traces"))
      .finally(() => setLoading(false));
  }, [userId, modelFilter, errorOnly, from, to, offset]);

  const emailFor = (id: string) => users.find((u) => u.id === id)?.email ?? id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>

        <input
          placeholder="model contains…"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        />

        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={errorOnly}
            onChange={(e) => {
              setErrorOnly(e.target.checked);
              setOffset(0);
            }}
          />
          errors only
        </label>

        <input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        />
        <span className="text-neutral-400">to</span>
        <input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        />

        <span className="text-xs text-neutral-400">{total} traces</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="py-1 pr-4 font-medium">When</th>
              <th className="py-1 pr-4 font-medium">User</th>
              <th className="py-1 pr-4 font-medium">Model</th>
              <th className="py-1 pr-4 font-medium">Iter</th>
              <th className="py-1 pr-4 font-medium">Tokens</th>
              <th className="py-1 pr-4 font-medium">Latency</th>
              <th className="py-1 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <TraceRow
                key={t.id}
                trace={t}
                email={emailFor(t.user_id)}
                open={expanded === t.id}
                onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
              />
            ))}
            {!loading && traces.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-neutral-400">
                  No traces match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}

function TraceRow({
  trace,
  email,
  open,
  onToggle,
}: {
  trace: AdminTrace;
  email: string;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
      >
        <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-400">
          {new Date(trace.created_at).toLocaleString()}
        </td>
        <td className="py-1.5 pr-4">{email}</td>
        <td className="py-1.5 pr-4 font-mono text-xs">{trace.model}</td>
        <td className="py-1.5 pr-4">{trace.iterations}</td>
        <td className="py-1.5 pr-4 whitespace-nowrap">
          {trace.input_tokens}↑ {trace.output_tokens}↓
        </td>
        <td className="py-1.5 pr-4">
          {trace.latency_ms != null ? `${(trace.latency_ms / 1000).toFixed(1)}s` : "—"}
        </td>
        <td className="py-1.5">
          {trace.error ? (
            <span className="text-red-600 dark:text-red-400">error</span>
          ) : (
            <span className={trace.stop_reason !== "end_turn" ? "text-amber-600 dark:text-amber-400" : "text-neutral-400"}>
              {trace.stop_reason}
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-200 dark:border-neutral-800">
          <td colSpan={7} className="bg-neutral-50 px-3 py-3 dark:bg-neutral-900/60">
            <TraceDetail id={trace.id} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The exact system prompt sent to the model for this run — full text, for tracing. */
function SystemPromptView({ value }: { value: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-2 py-1.5 font-medium text-neutral-500"
      >
        <span>system prompt ({value.length} chars)</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t border-neutral-200 whitespace-pre-wrap px-2 py-2 font-mono text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
          {value}
        </pre>
      )}
    </div>
  );
}

function TraceDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<AdminTraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGetTrace(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load trace"));
  }, [id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-neutral-400">Loading…</p>;

  return (
    <div className="space-y-2">
      {detail.error && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {detail.error}
        </p>
      )}
      {detail.system_prompt && <SystemPromptView value={detail.system_prompt} />}
      {detail.steps.length === 0 && (
        <p className="text-xs text-neutral-400">No tool calls in this run.</p>
      )}
      {detail.steps.map((step) => (
        <div
          key={step.iteration}
          className="rounded-lg border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="mb-1 font-medium text-neutral-500">
            step {step.iteration} · {step.inputTokens}↑ {step.outputTokens}↓ tok ·{" "}
            {(step.latencyMs / 1000).toFixed(1)}s
          </div>
          {step.toolCalls.length === 0 ? (
            <p className="text-neutral-400">no tool calls</p>
          ) : (
            <ul className="space-y-1">
              {step.toolCalls.map((call, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className={call.isError ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}>
                    {call.isError ? "✗" : "✓"}
                  </span>
                  <span className="font-mono">{call.name}</span>
                  <span className="truncate text-neutral-400">{JSON.stringify(call.input)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
