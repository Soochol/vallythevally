import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { retryDelay, shouldRetry } from "./api/retry";
import { ChartRoute } from "./App";
import { boot } from "./persist/boot";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => shouldRetry(count, e),
      retryDelay: (count, e) => retryDelay(count, e),
      refetchOnWindowFocus: false,
    },
  },
});

// React 밖에서 한 번만 되살린다. StrictMode가 효과를 두 번 부르더라도 복원은 한 번이다.
void boot(queryClient);

const router = createBrowserRouter([
  { path: "/", element: <ChartRoute /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
