import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { JobsTab } from "../components/admin/JobsTab.js";
import { MemoryTab } from "../components/admin/MemoryTab.js";
import { TracesTab } from "../components/admin/TracesTab.js";
import { UsersTab } from "../components/admin/UsersTab.js";
import { MenuButton } from "../components/Layout.js";
import { adminListUsers, type AdminUser } from "../lib/api.js";
import type { LayoutContext } from "../lib/types.js";

const TABS = [
  { id: "users", label: "Users" },
  { id: "memory", label: "Memory" },
  { id: "traces", label: "Traces" },
  { id: "jobs", label: "Jobs" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Admin-only: manage accounts, inspect a user's semantic memory, and monitor traces and background jobs. */
export function Admin() {
  const { toggleSidebar } = useOutletContext<LayoutContext>();
  const [tab, setTab] = useState<TabId>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);

  const refreshUsers = async () => setUsers(await adminListUsers());

  useEffect(() => {
    void refreshUsers();
  }, []);

  return (
    <>
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 text-sm font-medium sm:px-6 dark:border-neutral-800">
        <MenuButton onClick={toggleSidebar} />
        Admin
        <nav className="ml-2 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                tab === t.id
                  ? "bg-neutral-200 dark:bg-neutral-800"
                  : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-6 sm:px-6">
        {tab === "users" && <UsersTab users={users} onRefresh={refreshUsers} />}
        {tab === "memory" && <MemoryTab users={users} />}
        {tab === "traces" && <TracesTab users={users} />}
        {tab === "jobs" && <JobsTab users={users} />}
      </div>
    </>
  );
}
