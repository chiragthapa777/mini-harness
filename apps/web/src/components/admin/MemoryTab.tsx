import { useEffect, useState } from "react";
import { adminListFacts, type AdminFact, type AdminUser } from "../../lib/api.js";

const inputClass =
  "rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900";

const KINDS = ["fact", "profile", "domain_rule", "data_dictionary"] as const;
const LIMIT = 20;

/** Semantic memory — durable facts the summarizer wrote for one user, admin-viewable for any user. */
export function MemoryTab({ users }: { users: AdminUser[] }) {
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const [facts, setFacts] = useState<AdminFact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id);
  }, [users, userId]);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    adminListFacts(userId, { kind: kind || undefined, limit: LIMIT, offset })
      .then((res) => {
        setFacts(res.facts);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load memory"))
      .finally(() => setLoading(false));
  }, [userId, kind, offset]);

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
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>

        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>

        <span className="text-xs text-neutral-400">{total} facts</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="py-1 pr-4 font-medium">Kind</th>
              <th className="py-1 pr-4 font-medium">Content</th>
              <th className="py-1 pr-4 font-medium">Source</th>
              <th className="py-1 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-1.5 pr-4">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                    {f.kind}
                  </span>
                </td>
                <td className="max-w-md py-1.5 pr-4 whitespace-pre-wrap">{f.content}</td>
                <td className="py-1.5 pr-4 text-neutral-400">{f.source ?? "—"}</td>
                <td className="py-1.5 whitespace-nowrap text-neutral-400">
                  {new Date(f.updated_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {!loading && facts.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-neutral-400">
                  No memory for this user yet.
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

export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange(offset: number): void;
}) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-400">
      <button
        type="button"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
        className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
      >
        Prev
      </button>
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <button
        type="button"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
        className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
      >
        Next
      </button>
    </div>
  );
}
