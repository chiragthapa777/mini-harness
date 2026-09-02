import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  DataTable,
  PageHeader,
  Pager,
  buttonClass,
  type Column,
} from "../../components/admin/Table.js";
import { adminListSchedules, adminSetScheduleEnabled, type Schedule } from "../../lib/api.js";
import { useAdmin } from "./AdminLayout.js";

const LIMIT = 25;

/**
 * Every schedule in the system: the maintenance ones seeded from config
 * (summaries, consolidation, dedup, embedding backfill) and whatever users have
 * created. The only control here is pause/resume — cadences are config, and a
 * user's prompt is theirs to edit.
 */
export function AdminSchedules() {
  const { emailFor } = useAdmin();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminListSchedules({ limit: LIMIT, offset });
      setSchedules(result.schedules);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(schedule: Schedule) {
    setPendingId(schedule.id);
    try {
      await adminSetScheduleEnabled(schedule.id, !schedule.enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update schedule");
    } finally {
      setPendingId(null);
    }
  }

  const columns: Column<Schedule>[] = [
    {
      header: "Name",
      // Without a floor the name column collapses to its longest word and a
      // three-word schedule name becomes four lines.
      width: "min-w-52",
      cell: (schedule) => (
        <div className="space-y-1">
          <div>{schedule.name}</div>
          {schedule.prompt && (
            <div className="line-clamp-1 max-w-sm text-xs text-neutral-500">{schedule.prompt}</div>
          )}
        </div>
      ),
    },
    {
      header: "Kind",
      cell: (schedule) => (
        <Badge tone={schedule.kind === "system" ? "blue" : "neutral"}>{schedule.kind}</Badge>
      ),
    },
    { header: "Owner", cell: (schedule) => emailFor(schedule.user_id) },
    {
      header: "Job",
      cell: (schedule) => <span className="font-mono text-xs">{schedule.job_type}</span>,
    },
    {
      header: "Cron (UTC)",
      nowrap: true,
      cell: (schedule) => <span className="font-mono text-xs">{schedule.cron}</span>,
    },
    {
      header: "Status",
      cell: (schedule) =>
        schedule.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">paused</Badge>,
    },
    {
      header: "Last run",
      nowrap: true,
      cell: (schedule) => (
        <span className="text-neutral-500">
          {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      header: "Next run",
      nowrap: true,
      cell: (schedule) => (
        <span className="text-neutral-500">
          {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (schedule) => (
        <button
          type="button"
          disabled={pendingId === schedule.id}
          onClick={() => void toggle(schedule)}
          className={buttonClass}
        >
          {schedule.enabled ? "Pause" : "Resume"}
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Schedules"
        description="Maintenance schedules from config, plus whatever users have created."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <DataTable
        columns={columns}
        rows={schedules}
        rowKey={(schedule) => schedule.id}
        loading={loading}
        empty="No schedules yet — the worker seeds the maintenance ones on first tick."
      />
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}
