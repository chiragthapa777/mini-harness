import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Badge,
  DataTable,
  PageHeader,
  Pager,
  buttonClass,
  inputClass,
  type Column,
} from "../../components/admin/Table.js";
import {
  adminCreateUser,
  adminListUsers,
  adminUpdateUser,
  type AdminUser,
} from "../../lib/api.js";
import { useAdmin } from "./AdminLayout.js";

const LIMIT = 25;

/** There is no self-registration; this page is the only way an account gets created. */
export function AdminUsers() {
  const { refreshUsers } = useAdmin();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminListUsers({ limit: LIMIT, offset });
      setRows(result.users);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load users");
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation refreshes both this page and the pickers the layout owns. */
  const reload = async () => {
    await Promise.all([load(), refreshUsers()]);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminCreateUser(email, password, role);
      setEmail("");
      setPassword("");
      setRole("user");
      setAdding(false);
      setOffset(0);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, patch: { role?: "user" | "admin"; unlock?: boolean }) {
    setPendingId(id);
    try {
      await adminUpdateUser(id, patch);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update user");
    } finally {
      setPendingId(null);
    }
  }

  const isLocked = (user: AdminUser) =>
    Boolean(user.locked_until && new Date(user.locked_until).getTime() > Date.now());

  const columns: Column<AdminUser>[] = [
    { header: "Email", cell: (user) => user.email },
    {
      header: "Role",
      cell: (user) => (
        <select
          value={user.role}
          disabled={pendingId === user.id}
          onChange={(e) => void update(user.id, { role: e.target.value as "user" | "admin" })}
          className="rounded-md border border-neutral-200 bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-40 dark:border-neutral-700"
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      ),
    },
    {
      header: "Status",
      nowrap: true,
      cell: (user) =>
        isLocked(user) ? (
          <Badge tone="red">locked until {new Date(user.locked_until!).toLocaleTimeString()}</Badge>
        ) : user.failed_login_attempts > 0 ? (
          <Badge tone="amber">
            {user.failed_login_attempts} failed attempt{user.failed_login_attempts === 1 ? "" : "s"}
          </Badge>
        ) : (
          <Badge tone="green">ok</Badge>
        ),
    },
    {
      header: "Created",
      nowrap: true,
      cell: (user) => (
        <span className="text-neutral-500">{new Date(user.created_at).toLocaleDateString()}</span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (user) =>
        isLocked(user) || user.failed_login_attempts > 0 ? (
          <button
            type="button"
            disabled={pendingId === user.id}
            onClick={() => void update(user.id, { unlock: true })}
            className={buttonClass}
          >
            Unlock
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Accounts are created here — there is no sign-up.">
        <button type="button" onClick={() => setAdding((v) => !v)} className={buttonClass}>
          {adding ? "Cancel" : "Add user"}
        </button>
      </PageHeader>

      {adding && (
        <form
          onSubmit={submit}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
        >
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
            placeholder="Password (min 8)"
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
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Adding…" : "Create"}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(user) => user.id}
        loading={loading}
        empty="No users yet."
      />
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}
