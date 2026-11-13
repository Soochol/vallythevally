import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { saveScreens, screensQuery, useScreens } from "../../api/screener";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { useScreenerStore } from "../../stores/screener";
import { createWorkspace, type ScreensPort, type Workspace } from "./workspace";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const workspaces = new WeakMap<QueryClient, Workspace>();

const queryScreens = (client: QueryClient): ScreensPort => ({
  load: () => client.fetchQuery(screensQuery),
  put: async (screens, revision) => {
    try {
      return await saveScreens(client, screens, revision);
    } catch (e) {
      return { kind: "error", message: reason(e) };
    }
  },
});

export function workspaceFor(client: QueryClient): Workspace {
  const known = workspaces.get(client);
  if (known) return known;
  const workspace = createWorkspace({
    screens: queryScreens(client),
    runner: { runs: () => useScreenerStore.getState().runs, run: (screen) => useScreenerStore.getState().run(screen) },
    showsDrafts: () => typeof matchMedia !== "undefined" && matchMedia(DESKTOP_QUERY).matches,
  });
  const seeCached = () => {
    const list = client.getQueryData(screensQuery.queryKey);
    if (list) workspace.see(list);
  };
  seeCached();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === screensQuery.queryKey[0]) seeCached();
  });
  workspaces.set(client, workspace);
  return workspace;
}

export function useWorkspace() {
  const workspace = workspaceFor(useQueryClient());
  const query = useScreens();
  useSyncExternalStore(workspace.subscribe, workspace.snapshot, workspace.snapshot);
  useScreenerStore((s) => s.runs);
  useMediaQuery(DESKTOP_QUERY);
  return { workspace, view: workspace.view(), query };
}
