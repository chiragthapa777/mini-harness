import { Navigate, Outlet, useOutletContext } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import type { LayoutContext } from "../lib/types.js";

/**
 * Nests inside RequireAuth and Layout — a signed-in non-admin is bounced to
 * the chat home, not /login. `Outlet` drops its parent's context unless it is
 * re-passed explicitly, so Layout's `{ refresh, toggleSidebar }` is forwarded
 * here or `Admin` would read `undefined` from `useOutletContext`.
 */
export function RequireAdmin() {
  const { user } = useAuth();
  const context = useOutletContext<LayoutContext>();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet context={context} />;
}
