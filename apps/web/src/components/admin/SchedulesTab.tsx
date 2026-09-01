import { useCallback, useEffect, useState } from "react";
import {
  adminListSchedules,
  adminSetScheduleEnabled,
  type AdminUser,
  type Schedule,
} from "../../lib/api.js";

/**
 * Every schedule in the system: the maintenance ones seeded from config
 * (summaries, consolidation, dedup, embedding backfill) and whatever users
 * have created. The only control here is pause/resume — cadences are config,
 * and a user's prompt is theirs to edit.
 */
export function SchedulesTab({ users }: { users: AdminUser[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSchedules(await adminListSchedules());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load schedules");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const emailFor = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.email ?? id) : "system";

  async function toggle(schedule: Schedule) {
    try {
      await adminSetScheduleEnabled(schedule.id, !schedule.enabled);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update schedule");
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1 pr-4 font-medium">Kind</th>
              <th className="py-1 pr-4 font-medium">Owner</th>
              <th className="py-1 pr-4 font-medium">Job</th>
              <th className="py-1 pr-4 font-medium">Cron (UTC)</th>
              <th className="py-1 pr-4 font-medium">Last run</th>
              <th className="py-1 pr-4 font-medium">Next run</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule) => (
              <tr
                key={schedule.id}
                className="border-t border-neutral-200 align-top dark:border-neutral-800"
              >
                <td className="py-1.5 pr-4">
                  {schedule.name}
                  {!schedule.enabled && (
                    <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">paused</span>
                  )}
                </td>
                <td className="py-1.5 pr-4 text-neutral-400">{schedule.kind}</td>
                <td className="py-1.5 pr-4">{emailFor(schedule.user_id)}</td>
                <td className="py-1.5 pr-4 font-mono text-xs">{schedule.job_type}</td>
                <td className="py-1.5 pr-4 font-mono text-xs">{schedule.cron}</td>
                <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-400">
                  {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString() : "—"}
                </td>
                <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-400">
                  {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "—"}
                </td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => void toggle(schedule)}
                    className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </button>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-neutral-400">
                  No schedules yet — the worker seeds the maintenance ones on first tick.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
