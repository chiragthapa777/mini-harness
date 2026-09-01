import { useCallback, useEffect, useState } from "react";
import {
  adminJobStats,
  adminListJobs,
  adminRetryJob,
  type AdminJob,
  type AdminUser,
  type JobStatus,
} from "../../lib/api.js";
import { Pager } from "./MemoryTab.js";
import { TraceDetail } from "./TracesTab.js";

const inputClass =
  "rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900";

const LIMIT = 50;
const STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed"];

const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "text-neutral-400",
  running: "text-blue-600 dark:text-blue-400",
  succeeded: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
};

/**
 * Background work — the same `jobs` rows the worker claims from. The table is
 * both queue and audit log, so this one view covers "what is pending right
 * now" and "what failed last night".
 */
export function JobsTab({ users }: { users: AdminUser[] }) {
  const [status, setStatus] = useState<JobStatus | "">("");
  const [type, setType] = useState("");
  const [userId, setUserId] = useState("");
  const [offset, setOffset] = useState(0);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{ status: JobStatus; type: string; count: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listed, counts] = await Promise.all([
        adminListJobs({
          status: status || undefined,
          type: type || undefined,
          userId: userId || undefined,
          limit: LIMIT,
          offset,
        }),
        adminJobStats(),
      ]);
      setJobs(listed.jobs);
      setTotal(listed.total);
      setStats(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, [status, type, userId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // A queue is only useful live — anything queued or running moves on its own.
  useEffect(() => {
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const types = [...new Set(stats.map((s) => s.type))].sort();
  const byStatus = (s: JobStatus) =>
    stats.filter((row) => row.status === s).reduce((sum, row) => sum + row.count, 0);

  const emailFor = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.email ?? id) : "system";

  const retry = async (id: string) => {
    try {
      await adminRetryJob(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "retry failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStatus(status === s ? "" : s);
              setOffset(0);
            }}
            className={`rounded-xl border px-3 py-1.5 text-left text-sm ${
              status === s
                ? "border-neutral-400 dark:border-neutral-500"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
          >
            <span className={`font-medium ${STATUS_COLOR[s]}`}>{byStatus(s)}</span>{" "}
            <span className="text-xs text-neutral-400">{s}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

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

        <span className="text-xs text-neutral-400">{total} jobs</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="py-1 pr-4 font-medium">Created</th>
              <th className="py-1 pr-4 font-medium">Type</th>
              <th className="py-1 pr-4 font-medium">User</th>
              <th className="py-1 pr-4 font-medium">Status</th>
              <th className="py-1 pr-4 font-medium">Tries</th>
              <th className="py-1 pr-4 font-medium">Error</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                email={emailFor(job.user_id)}
                open={expanded === job.id}
                onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
                onRetry={() => retry(job.id)}
              />
            ))}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-neutral-400">
                  No jobs match these filters.
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

function JobRow({
  job,
  email,
  open,
  onToggle,
  onRetry,
}: {
  job: AdminJob;
  email: string;
  open: boolean;
  onToggle(): void;
  onRetry(): void;
}) {
  const finished = job.status === "failed" || job.status === "succeeded";
  const traceId = (job.result as { traceId?: string } | null)?.traceId;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
      >
        <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-400">
          {new Date(job.created_at).toLocaleString()}
        </td>
        <td className="py-1.5 pr-4 font-mono text-xs">{job.type}</td>
        <td className="py-1.5 pr-4">{email}</td>
        <td className={`py-1.5 pr-4 ${STATUS_COLOR[job.status]}`}>{job.status}</td>
        <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-400">
          {job.attempts}/{job.max_attempts}
        </td>
        <td className="max-w-70 truncate py-1.5 pr-4 text-red-600 dark:text-red-400">
          {job.last_error ?? ""}
        </td>
        <td className="py-1.5">
          {finished && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
            >
              Retry
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-200 dark:border-neutral-800">
          <td colSpan={7} className="space-y-2 bg-neutral-50 px-3 py-3 dark:bg-neutral-900/60">
            <Field label="payload" value={JSON.stringify(job.payload, null, 2)} />
            {job.result != null && (
              <Field label="result" value={JSON.stringify(job.result, null, 2)} />
            )}
            {job.last_error && <Field label="error" value={job.last_error} />}
            <p className="text-xs text-neutral-400">
              scheduled {new Date(job.scheduled_for).toLocaleString()}
              {job.started_at && ` · started ${new Date(job.started_at).toLocaleString()}`}
              {job.finished_at && ` · finished ${new Date(job.finished_at).toLocaleString()}`}
              {job.dedupe_key && ` · key ${job.dedupe_key}`}
            </p>
            {/* A job that ran the agent loop wrote a trace; show it inline
                rather than making someone hunt for it in the Traces tab. */}
            {traceId && <TraceDetail id={traceId} />}
          </td>
        </tr>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <div className="px-2 py-1 font-medium text-neutral-500">{label}</div>
      <pre className="max-h-64 overflow-auto border-t border-neutral-200 px-2 py-2 font-mono whitespace-pre-wrap text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
        {value}
      </pre>
    </div>
  );
}
