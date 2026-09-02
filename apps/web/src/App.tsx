import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { RequireAdmin } from "./components/RequireAdmin.js";
import { RequireAuth } from "./components/RequireAuth.js";
import { AuthProvider } from "./lib/AuthContext.js";
import { AdminLayout } from "./pages/admin/AdminLayout.js";
import { AdminJobs } from "./pages/admin/Jobs.js";
import { AdminMemory } from "./pages/admin/Memory.js";
import { AdminSchedules } from "./pages/admin/Schedules.js";
import { AdminTraces } from "./pages/admin/Traces.js";
import { AdminUsers } from "./pages/admin/Users.js";
import { Chat } from "./pages/Chat.js";
import { Login } from "./pages/Login.js";
import { Schedules } from "./pages/Schedules.js";

/**
 * Two chat modes over the same conversations: the original non-streaming
 * request/response, and the SSE stream. Mode is a `?mode=stream` query param,
 * not a path segment — both modes share the same conversation URLs. Everything
 * under the chat layout requires a signed-in user; /login does not. There is
 * no self-service registration — /admin (admin-only) is how new accounts get
 * created.
 */
const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: <Layout />,
        children: [
          { index: true, element: <Chat /> },
          { path: "c/:id", element: <Chat /> },
          { path: "schedules", element: <Schedules /> },
          {
            element: <RequireAdmin />,
            children: [
              {
                // One route per admin page rather than tabs: each gets an
                // address worth sharing, a back button, and its own pagination.
                path: "admin",
                element: <AdminLayout />,
                children: [
                  { index: true, element: <Navigate to="/admin/users" replace /> },
                  { path: "users", element: <AdminUsers /> },
                  { path: "memory", element: <AdminMemory /> },
                  { path: "traces", element: <AdminTraces /> },
                  { path: "jobs", element: <AdminJobs /> },
                  { path: "schedules", element: <AdminSchedules /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
