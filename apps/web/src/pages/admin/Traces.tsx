import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  DataTable,
  Field,
  PageHeader,
  Pager,
  Toolbar,
  inputClass,
  type Column,
} from "../../components/admin/Table.js";
import {
  adminGetTrace,
  adminListTraces,
  type AdminTrace,
  type AdminTraceDetail,
} from "../../lib/api.js";
import { useAdmin } from "./AdminLayout.js";

const LIMIT = 25;

/** LLM Ops — every run, filterable by user, model, error status, and date range. */
export function AdminTraces() {
  const { users, emailFor } = useAdmin();
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

  // A trace's model field is free text ("openrouter/gpt-4o"), so the filter is
  // a substring search — debounce it, or every keystroke fires a request.
  useEffect(() => {
    const id = setTimeout(() => setModelFilter(model), 300);
    return () => clearTimeout(id);
  }, [model]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminListTraces({
        userId: userId || undefined,
        model: modelFilter || undefined,
        errorOnly,
        from: from || undefined,
        to: to || undefined,
        limit: LIMIT,
        offset,
      });
      setTraces(result.traces);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [userId, modelFilter, errorOnly, from, to, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<AdminTrace>[] = [
    {
      header: "When",
      nowrap: true,
      cell: (trace) => (
        <span className="text-neutral-500">{new Date(trace.created_at).toLocaleString()}</span>
      ),
    },
    { header: "User", cell: (trace) => emailFor(trace.user_id) },
    {
      header: "Model",
      cell: (trace) => <span className="font-mono text-xs">{trace.model}</span>,
    },
    { header: "Iter", align: "right", cell: (trace) => trace.iterations },
    {
      header: "Tokens",
      align: "right",
      nowrap: true,
      cell: (trace) => (
        <span className="text-neutral-500">
          {trace.input_tokens}↑ {trace.output_tokens}↓
        </span>
      ),
    },
    {
      header: "Latency",
      align: "right",
      nowrap: true,
      cell: (trace) =>
        trace.latency_ms != null ? `${(trace.latency_ms / 1000).toFixed(1)}s` : "—",
    },
    {
      header: "Result",
      cell: (trace) =>
        trace.error ? (
          <Badge tone="red">error</Badge>
        ) : trace.stop_reason !== "end_turn" ? (
          <Badge tone="amber">{trace.stop_reason}</Badge>
        ) : (
          <Badge tone="green">{trace.stop_reason}</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Traces" description="One row per agent run. Click a row for its steps." />

      <Toolbar>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all users</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.email}
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
      </Toolbar>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <DataTable
        columns={columns}
        rows={traces}
        rowKey={(trace) => trace.id}
        loading={loading}
        empty="No traces match these filters."
        onRowClick={(trace) => setExpanded(expanded === trace.id ? null : trace.id)}
        isExpanded={(trace) => expanded === trace.id}
        expanded={(trace) => <TraceDetail id={trace.id} />}
      />
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}

/**
 * The steps of one run, plus the exact system prompt it was sent. Shared with
 * the Jobs page, where a scheduled run links straight to its trace.
 */
export function TraceDetail({ id }: { id: string }) {
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
        <p className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {detail.error}
        </p>
      )}
      {detail.system_prompt && <Field label="system prompt" value={detail.system_prompt} />}

      {detail.steps.length === 0 ? (
        <p className="text-xs text-neutral-400">No tool calls in this run.</p>
      ) : (
        detail.steps.map((step) => (
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
                {step.toolCalls.map((call, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span
                      className={
                        call.isError
                          ? "text-red-600 dark:text-red-400"
                          : "text-green-600 dark:text-green-400"
                      }
                    >
                      {call.isError ? "✗" : "✓"}
                    </span>
                    <span className="font-mono">{call.name}</span>
                    <span className="truncate text-neutral-400">{JSON.stringify(call.input)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </div>
  );
}
