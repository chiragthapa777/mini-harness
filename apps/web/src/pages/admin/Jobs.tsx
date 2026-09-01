import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  DataTable,
  Field,
  PageHeader,
  Pager,
  Toolbar,
  buttonClass,
  inputClass,
  type Column,
} from "../../components/admin/Table.js";
import {
  adminJobStats,
  adminListJobs,
  adminRetryJob,
  type AdminJob,
  type JobStatus,
} from "../../lib/api.js";
import { useAdmin } from "./AdminLayout.js";
import { TraceDetail } from "./Traces.js";

const LIMIT = 25;
const STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed"];

const TONE: Record<JobStatus, "neutral" | "blue" | "green" | "red"> = {
  queued: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
};

/**
 * Background work — the same `jobs` rows the worker claims from. The table is
 * both queue and audit log, so this one page covers "what is pending right
 * now" and "what failed last night".
 */
export function AdminJobs() {
  const { users, emailFor } = useAdmin();
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

  const types = [...new Set(stats.map((row) => row.type))].sort();
  const countFor = (value: JobStatus) =>
    stats.filter((row) => row.status === value).reduce((sum, row) => sum + row.count, 0);

  async function retry(id: string) {
    try {
      await adminRetryJob(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "retry failed");
    }
  }

  const columns: Column<AdminJob>[] = [
    {
      header: "Created",
      nowrap: true,
      cell: (job) => (
        <span className="text-neutral-500">{new Date(job.created_at).toLocaleString()}</span>
      ),
    },
    { header: "Type", cell: (job) => <span className="font-mono text-xs">{job.type}</span> },
    { header: "User", cell: (job) => emailFor(job.user_id) },
    { header: "Status", cell: (job) => <Badge tone={TONE[job.status]}>{job.status}</Badge> },
    {
      header: "Tries",
      align: "right",
      nowrap: true,
      cell: (job) => (
        <span className="text-neutral-500">
          {job.attempts}/{job.max_attempts}
        </span>
      ),
    },
    {
      header: "Error",
      width: "max-w-xs",
      cell: (job) => (
        <span className="line-clamp-2 text-red-600 dark:text-red-400">{job.last_error ?? ""}</span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (job) =>
        job.status === "failed" || job.status === "succeeded" ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void retry(job.id);
            }}
            className={buttonClass}
          >
            Retry
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Jobs" description="Background work, live. Click a row for its payload." />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setStatus(status === value ? "" : value);
              setOffset(0);
            }}
            className={`rounded-xl border px-3 py-2 text-left ${
              status === value
                ? "border-neutral-400 dark:border-neutral-500"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
          >
            <div className="text-lg font-semibold">{countFor(value)}</div>
            <div className="text-xs text-neutral-500">{value}</div>
          </button>
        ))}
      </div>

      <Toolbar>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all types</option>
          {types.map((value) => (
            <option key={value} value={value}>
              {value}
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
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.email}
            </option>
          ))}
        </select>
      </Toolbar>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <DataTable
        columns={columns}
        rows={jobs}
        rowKey={(job) => job.id}
        loading={loading}
        empty="No jobs match these filters."
        onRowClick={(job) => setExpanded(expanded === job.id ? null : job.id)}
        isExpanded={(job) => expanded === job.id}
        expanded={(job) => <JobDetail job={job} />}
      />
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}

function JobDetail({ job }: { job: AdminJob }) {
  const traceId = (job.result as { traceId?: string } | null)?.traceId;

  return (
    <div className="space-y-2">
      <Field label="payload" value={JSON.stringify(job.payload, null, 2)} />
      {job.result != null && <Field label="result" value={JSON.stringify(job.result, null, 2)} />}
      {job.last_error && <Field label="error" value={job.last_error} />}

      <p className="text-xs text-neutral-500">
        scheduled {new Date(job.scheduled_for).toLocaleString()}
        {job.started_at && ` · started ${new Date(job.started_at).toLocaleString()}`}
        {job.finished_at && ` · finished ${new Date(job.finished_at).toLocaleString()}`}
        {job.dedupe_key && ` · key ${job.dedupe_key}`}
      </p>

      {/* A job that ran the agent loop wrote a trace; show it here rather than
          making someone hunt for it on the Traces page. */}
      {traceId && <TraceDetail id={traceId} />}
    </div>
  );
}
