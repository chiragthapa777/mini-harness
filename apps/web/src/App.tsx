import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { ChatClassic } from "./pages/ChatClassic.js";
import { ChatStream } from "./pages/ChatStream.js";

/**
 * Two chat modes over the same conversations: the original non-streaming
 * request/response, and the SSE stream at /stream.
 */
const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <ChatClassic /> },
      { path: "c/:id", element: <ChatClassic /> },
      { path: "stream", element: <ChatStream /> },
      { path: "stream/c/:id", element: <ChatStream /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
