import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { deleteConversation, listConversations } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.js";
import type { Conversation } from "../lib/types.js";

/** Conversations are shared by both chat modes, so the list lives in the layout. */
export function Layout() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // Response mode is a query param, not a path segment, so it survives
  // sidebar navigation only if we carry it along ourselves. Streaming is the
  // default; classic needs the explicit param.
  const mode = searchParams.get("mode") === "classic" ? "classic" : "stream";
  const modeSuffix = mode === "classic" ? "?mode=classic" : "";

  const refresh = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      // The sidebar is not worth failing the page over.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, id]);

  // A picked conversation (or a fresh chat) closes the mobile drawer.
  useEffect(() => {
    setSidebarOpen(false);
  }, [id]);

  async function remove(conversationId: string) {
    await deleteConversation(conversationId);
    if (conversationId === id) navigate(`/${modeSuffix}`);
    void refresh();
  }

  return (
    <div className="flex h-dvh bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 -translate-x-full flex-col border-r border-neutral-200 bg-neutral-50 transition-transform duration-200 md:static md:w-64 md:translate-x-0 dark:border-neutral-900 dark:bg-neutral-950 ${
          sidebarOpen ? "translate-x-0" : ""
        }`}
      >
        <div className="px-4 pt-4 pb-1">
          <span className="text-lg font-semibold tracking-tight">mini-agent</span>
        </div>

        <div className="space-y-1 p-3">
          <Link
            to={`/${modeSuffix}`}
            onClick={() => setSidebarOpen(false)}
            className="flex items-center gap-2 rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium hover:bg-neutral-300 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            <PlusIcon />
            New chat
          </Link>
          {user?.role === "admin" && (
            <Link
              to="/admin"
              onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              <AdminIcon />
              Admin
            </Link>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
          <p className="px-2 pt-2 pb-1 text-xs font-medium text-neutral-400">Chats</p>
          {conversations.length === 0 && (
            <p className="px-2 py-4 text-xs text-neutral-400">No conversations yet.</p>
          )}
          {conversations.map((conversation) => (
            <div key={conversation.id} className="group relative">
              <NavLink
                to={`/c/${conversation.id}${modeSuffix}`}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `block truncate rounded-lg px-3 py-2 pr-8 text-sm ${
                    isActive
                      ? "bg-neutral-200 dark:bg-neutral-900"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  }`
                }
              >
                {conversation.title ?? "Untitled"}
              </NavLink>
              <button
                type="button"
                onClick={() => void remove(conversation.id)}
                aria-label="Delete conversation"
                className="absolute right-2 top-1.5 hidden rounded px-1.5 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 group-hover:block dark:hover:bg-neutral-800"
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-3 dark:border-neutral-900">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-medium dark:bg-neutral-800">
            {(user?.email ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
            {user?.email}
          </span>
          <button
            type="button"
            onClick={() => {
              logout();
              navigate("/login");
            }}
            aria-label="Sign out"
            title="Sign out"
            className="shrink-0 rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-900 dark:hover:text-neutral-300"
          >
            <SignOutIcon />
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet context={{ refresh, toggleSidebar: () => setSidebarOpen((v) => !v) }} />
      </main>
    </div>
  );
}

/** Opens the conversation drawer on mobile; the sidebar is already visible on desktop. */
export function MenuButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Toggle sidebar"
      className="-ml-1 rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 md:hidden dark:hover:bg-neutral-900"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3l7 3v5c0 4.4-2.9 8.4-7 9.5-4.1-1.1-7-5.1-7-9.5V6l7-3z"
      />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"
      />
    </svg>
  );
}

