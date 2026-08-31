import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { deleteConversation, listConversations } from "../lib/api.js";
import type { Conversation } from "../lib/types.js";

/** Conversations are shared by both chat modes, so the list lives in the layout. */
export function Layout() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

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

  async function remove(conversationId: string) {
    await deleteConversation(conversationId);
    if (conversationId === id) navigate(base || "/");
    void refresh();
  }

  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="p-3">
          <Link
            to={base || "/"}
            className="block rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            + New chat
          </Link>
        </div>

        <div className="px-3 pb-2">
          <div className="flex rounded-lg bg-neutral-100 p-0.5 text-xs dark:bg-neutral-900">
            <ModeTab to={id ? `/c/${id}` : "/"} active={mode === "classic"}>
              Classic
            </ModeTab>
            <ModeTab to={id ? `/stream/c/${id}` : "/stream"} active={mode === "stream"}>
              Streaming
            </ModeTab>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 && (
            <p className="px-2 py-4 text-xs text-neutral-400">No conversations yet.</p>
          )}
          {conversations.map((conversation) => (
            <div key={conversation.id} className="group relative">
              <NavLink
                to={`${base}/c/${conversation.id}`}
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

        <div className="border-t border-neutral-200 px-4 py-3 text-[11px] text-neutral-400 dark:border-neutral-800">
          mini-agent
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet context={{ refresh }} />
      </main>
    </div>
  );
}

function ModeTab({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      to={to}
      className={`flex-1 rounded-md py-1.5 text-center font-medium ${
        active
          ? "bg-white shadow-sm dark:bg-neutral-700"
          : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      }`}
    >
      {children}
    </Link>
  );
}
