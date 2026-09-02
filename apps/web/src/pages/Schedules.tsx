import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { MenuButton } from "../components/Layout.js";
import {
  createSchedule,
  listSchedules,
  previewCron,
  removeSchedule,
  updateSchedule,
  type Schedule,
} from "../lib/api.js";
import type { LayoutContext } from "../lib/types.js";

const inputClass =
  "w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900";

const PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day 9am", cron: "0 9 * * *" },
  { label: "Weekdays 8am", cron: "0 8 * * 1-5" },
  { label: "Every Monday", cron: "0 9 * * 1" },
];

/**
 * A schedule is a prompt on a cadence: the scheduler enqueues a job, the
 * worker runs the same agent loop the chat box does, and the answer lands in a
 * conversation. Cron is UTC — shown as local time in the preview so nobody has
 * to do the arithmetic.
 */
export function Schedules() {
  const { toggleSidebar } = useOutletContext<LayoutContext>();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [preview, setPreview] = useState<string[]>([]);
  const [cronError, setCronError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSchedules(await listSchedules());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load schedules");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Validate against the same parser the scheduler uses rather than a second
  // copy of the rules in the browser.
  useEffect(() => {
    const id = setTimeout(() => {
      previewCron(cron)
        .then((res) => {
          setPreview(res.runs);
          setCronError(null);
        })
        .catch((err) => {
          setPreview([]);
          setCronError(err instanceof Error ? err.message : "invalid cron");
        });
    }, 300);
    return () => clearTimeout(id);
  }, [cron]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createSchedule({ name, prompt, cron });
      setName("");
      setPrompt("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create schedule");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(schedule: Schedule) {
    await updateSchedule(schedule.id, { enabled: !schedule.enabled });
    await refresh();
  }

  async function remove(id: string) {
    await removeSchedule(id);
    await refresh();
  }

  return (
    <>
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 text-sm font-medium sm:px-6 dark:border-neutral-800">
        <MenuButton onClick={toggleSidebar} />
        Schedules
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-6 sm:px-6">
        <form onSubmit={submit} className="max-w-2xl space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name — e.g. Morning briefing"
            required
            className={inputClass}
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do each time?"
            required
            rows={3}
            className={inputClass}
          />

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="*/5 * * * *"
              className={`${inputClass} max-w-40 font-mono`}
            />
            {PRESETS.map((preset) => (
              <button
                key={preset.cron}
                type="button"
                onClick={() => setCron(preset.cron)}
                className="rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {cronError ? (
            <p className="text-xs text-red-600">{cronError}</p>
          ) : (
            <p className="text-xs text-neutral-400">
              Next: {preview.slice(0, 3).map((run) => new Date(run).toLocaleString()).join(" · ")}
            </p>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={saving || Boolean(cronError)}
            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {saving ? "Saving…" : "Create schedule"}
          </button>
        </form>

        <div className="space-y-2">
          {schedules.length === 0 && (
            <p className="text-sm text-neutral-400">No schedules yet.</p>
          )}
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              <span className="font-medium">{schedule.name}</span>
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800">
                {schedule.cron}
              </span>
              {!schedule.enabled && <span className="text-xs text-amber-600">paused</span>}
              <span className="w-full truncate text-xs text-neutral-400 sm:w-auto sm:flex-1">
                {schedule.prompt}
              </span>
              <span className="text-xs text-neutral-400">
                {schedule.next_run_at
                  ? `next ${new Date(schedule.next_run_at).toLocaleString()}`
                  : "not scheduled"}
              </span>
              <button
                type="button"
                onClick={() => void toggle(schedule)}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
              >
                {schedule.enabled ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                onClick={() => void remove(schedule.id)}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-red-600 dark:border-neutral-700"
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        <p className="text-xs text-neutral-400">
          Times are UTC. A run appears in <Link to="/" className="underline">your chats</Link> when
          it finishes.
        </p>
      </div>
    </>
  );
}
