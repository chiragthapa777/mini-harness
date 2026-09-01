import { useState, type FormEvent } from "react";
import { adminCreateUser, adminUpdateUser, type AdminUser } from "../../lib/api.js";

const inputClass =
  "w-full rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900";

/** There is no self-registration; this is the only way a new account gets created. */
export function UsersTab({
  users,
  onRefresh,
}: {
  users: AdminUser[];
  onRefresh(): Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminCreateUser(email, password, role);
      setEmail("");
      setPassword("");
      setRole("user");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(id: string, next: "user" | "admin") {
    setPendingId(id);
    try {
      await adminUpdateUser(id, { role: next });
      await onRefresh();
    } finally {
      setPendingId(null);
    }
  }

  async function unlock(id: string) {
    setPendingId(id);
    try {
      await adminUpdateUser(id, { unlock: true });
      await onRefresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <h2 className="text-sm font-semibold">Add user</h2>

        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "user" | "admin")}
          className={inputClass}
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-neutral-400">
              <tr>
                <th className="py-1 pr-4 font-medium">Email</th>
                <th className="py-1 pr-4 font-medium">Role</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 pr-4 font-medium">Created</th>
                <th className="py-1 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const locked = u.locked_until && new Date(u.locked_until).getTime() > Date.now();
                const disabled = pendingId === u.id;
                return (
                  <tr key={u.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="py-1.5 pr-4">{u.email}</td>
                    <td className="py-1.5 pr-4">
                      <select
                        value={u.role}
                        disabled={disabled}
                        onChange={(e) => void changeRole(u.id, e.target.value as "user" | "admin")}
                        className="rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-40 dark:border-neutral-700"
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="py-1.5 pr-4">
                      {locked ? (
                        <span className="text-red-600">
                          locked until {new Date(u.locked_until as string).toLocaleString()}
                        </span>
                      ) : u.failed_login_attempts > 0 ? (
                        <span className="text-neutral-400">
                          {u.failed_login_attempts} failed attempt
                          {u.failed_login_attempts === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-neutral-400">ok</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-4 text-neutral-400">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-1.5">
                      {(locked || u.failed_login_attempts > 0) && (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => void unlock(u.id)}
                          className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
                        >
                          Unlock
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
