import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { saveScreens, screenerStatusQuery, screensQuery, useScreens } from "../../api/screener";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { runBlock } from "../../lib/screener";
import { useScreenerStore } from "../../stores/screener";
import { createScreenEditing, type ScreenEditing, type ScreenRunner, type ScreensPort } from "./screenEditing";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const editings = new WeakMap<QueryClient, ScreenEditing>();

export const queryScreens = (client: QueryClient): ScreensPort => ({
  watch: (see) => {
    const seeCached = () => {
      const list = client.getQueryData(screensQuery.queryKey);
      if (list) see(list);
    };
    seeCached();
    client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === screensQuery.queryKey[0]) seeCached();
    });
  },
  load: async () => {
    try {
      return { kind: "ok", list: await client.fetchQuery(screensQuery) };
    } catch (e) {
      return { kind: "error", message: reason(e) };
    }
  },
  put: async (screens, base) => {
    try {
      return await saveScreens(client, screens, base);
    } catch (e) {
      return { kind: "error", message: reason(e) };
    }
  },
});

const storeRunner = (client: QueryClient): ScreenRunner => ({
  runs: () => useScreenerStore.getState().runs,
  check: async () => {
    try {
      const status = await client.fetchQuery({ ...screenerStatusQuery(1000), staleTime: 0 });
      return runBlock(status) === null ? { kind: "ready" } : { kind: "blocked" };
    } catch (e) {
      return { kind: "error", message: reason(e) };
    }
  },
  run: async (screen) => {
    await useScreenerStore.getState().run(screen);
    await client.invalidateQueries({ queryKey: screenerStatusQuery(1000).queryKey });
  },
});

export function screenEditingFor(client: QueryClient): ScreenEditing {
  const known = editings.get(client);
  if (known) return known;
  const editing = createScreenEditing({
    screens: queryScreens(client),
    runner: storeRunner(client),
    showsDrafts: () => typeof matchMedia !== "undefined" && matchMedia(DESKTOP_QUERY).matches,
  });
  editings.set(client, editing);
  return editing;
}

export function useScreenEditing() {
  const editing = screenEditingFor(useQueryClient());
  const query = useScreens();
  useScreenerStore((s) => s.runs);
  useMediaQuery(DESKTOP_QUERY);
  const view = useSyncExternalStore(editing.subscribe, editing.view, editing.view);
  return { editing, view, query };
}
