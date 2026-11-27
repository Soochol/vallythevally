import { serverModeProbe } from "./public-mode/modeProbe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { retryDelay, shouldRetry } from "./api/retry";
import { ChartRoute } from "./App";
import { CollectorPage } from "./features/collector-board/CollectorPage";
import { takeLoginFailure } from "./features/account/loginFailure";
import { ALL_PAGES, JOURNAL_ANALYTICS_PATH } from "./features/page-rail/pages";
import { ShellErrorBoundary } from "./features/shell/ShellErrorBoundary";
import { start } from "./persist/start";
import { useAccountStore } from "./stores/account";
import { marketSocket } from "./stores/realtime";
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

const loginFailure = takeLoginFailure(new URL(location.href));
if (loginFailure) {
  history.replaceState(history.state, "", loginFailure.cleaned);
  useAccountStore.getState().showLoginFailure(loginFailure.text);
}

const serverMode = await serverModeProbe;

// React 밖에서 한 번만 되살린다. StrictMode가 효과를 두 번 부르더라도 복원은 한 번이다.
void start();
if (serverMode === "local") marketSocket.start();

const router = createBrowserRouter([
  {
    element: <ShellErrorBoundary><ChartRoute /></ShellErrorBoundary>,
    children: [...ALL_PAGES.map(({ path }) => ({ path })), { path: JOURNAL_ANALYTICS_PATH }],
  },
  { path: "/collector", element: <CollectorPage /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
