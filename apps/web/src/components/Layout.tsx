import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { deleteConversation, listConversations } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.js";
import type { Conversation } from "../lib/types.js";

/** Conversations are shared by both chat modes, so the list lives in the layout. */
export function Layout() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const mode = location.pathname.startsWith("/stream") ? "stream" : "classic";
  const base = mode === "stream" ? "/stream" : "";

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
    if (conversationId === id) navigate(base || "/");
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
        className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 -translate-x-full flex-col border-r border-neutral-200 bg-white transition-transform duration-200 md:static md:w-64 md:translate-x-0 dark:border-neutral-800 dark:bg-neutral-950 ${
          sidebarOpen ? "translate-x-0" : ""
        }`}
      >
        <div className="space-y-1.5 p-3">
          <Link
            to={base || "/"}
            onClick={() => setSidebarOpen(false)}
            className="block rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            + New chat
          </Link>
          {user?.role === "admin" && (
            <Link
              to="/admin"
              onClick={() => setSidebarOpen(false)}
              className="block rounded-lg border border-neutral-300 px-3 py-2 text-center text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Admin
            </Link>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 && (
            <p className="px-2 py-4 text-xs text-neutral-400">No conversations yet.</p>
          )}
          {conversations.map((conversation) => (
            <div key={conversation.id} className="group relative">
              <NavLink
                to={`${base}/c/${conversation.id}`}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `block truncate rounded-lg px-3 py-2 pr-8 text-sm ${
                    isActive
                      ? "bg-neutral-200 dark:bg-neutral-800"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  }`
                }
              >
                {conversation.title ?? "Untitled"}
                <span className="block text-[11px] text-neutral-400">
                  {conversation.message_count} messages
                </span>
              </NavLink>
              <button
                type="button"
                onClick={() => void remove(conversation.id)}
                aria-label="Delete conversation"
                className="absolute right-2 top-2 hidden rounded px-1.5 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 group-hover:block dark:hover:bg-neutral-700"
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 px-4 py-3 text-[11px] text-neutral-400 dark:border-neutral-800">
          <span className="truncate">{user?.email ?? "mini-agent"}</span>
          <button
            type="button"
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-900 dark:hover:text-neutral-300"
          >
            Sign out
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

