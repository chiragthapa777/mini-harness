import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { MenuButton } from "../../components/Layout.js";
import { adminListUsers, type AdminUser } from "../../lib/api.js";
import type { LayoutContext } from "../../lib/types.js";

/**
 * The admin section: one route per page rather than tabs in a single one.
 *
 * Tabs kept everything in one component's state, so a filter survived a tab
 * switch but nothing survived a reload, and there was no URL to send anyone.
 * Routes give each page its own address, its own back button, and its own
 * mount — which is also what makes each page's pagination independent.
 *
 * The user list is fetched once here because four of the five pages need it
 * for a picker, and refetching it per page would be four identical requests.
 */
const PAGES = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/memory", label: "Memory" },
  { to: "/admin/traces", label: "Traces" },
  { to: "/admin/jobs", label: "Jobs" },
  { to: "/admin/schedules", label: "Schedules" },
];

export interface AdminContext {
  /** Enough users to fill a picker, not a paginated view — see the Users page for that. */
  users: AdminUser[];
  refreshUsers(): Promise<void>;
  emailFor(id: string | null): string;
}

export function AdminLayout() {
  const { toggleSidebar } = useOutletContext<LayoutContext>();
  const [users, setUsers] = useState<AdminUser[]>([]);

  const refreshUsers = useCallback(async () => {
    const { users: loaded } = await adminListUsers({ limit: 500 });
    setUsers(loaded);
  }, []);

  useEffect(() => {
    void refreshUsers();
  }, [refreshUsers]);

  const emailFor = useCallback(
    (id: string | null) => (id ? (users.find((u) => u.id === id)?.email ?? id) : "system"),
    [users],
  );

  const context: AdminContext = { users, refreshUsers, emailFor };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 text-sm font-medium sm:px-6 dark:border-neutral-800">
        <MenuButton onClick={toggleSidebar} />
        Admin
        <nav className="ml-2 flex gap-1 overflow-x-auto">
          {PAGES.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              className={({ isActive }) =>
                `rounded-lg px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  isActive
                    ? "bg-neutral-200 dark:bg-neutral-800"
                    : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
                }`
              }
            >
              {page.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-6 sm:px-6">
        <Outlet context={context} />
      </div>
    </>
  );
}

/** Typed access to what the layout loaded, for the pages under it. */
export function useAdmin(): AdminContext {
  return useOutletContext<AdminContext>();
}
