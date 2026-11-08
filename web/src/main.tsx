import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ApiRequestError } from "./api/http";
import { ChartScreen } from "./App";
import "./styles/index.css";

const RETRYABLE = new Set(["kiwoom_unavailable", "network"]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => count < 2 && e instanceof ApiRequestError && RETRYABLE.has(e.code),
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  { path: "/", element: <ChartScreen /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
