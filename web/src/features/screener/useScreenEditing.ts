import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { saveScreens, screenerStatusQuery, screensQuery, useScreens } from "../../api/screener";
import { runBlock } from "../../lib/screener";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { useScreenerStore } from "../../stores/screener";
import { confirmAction } from "../overlay/Confirm";
import { dropPendingOpen } from "./resultActions";
import { type ChosenScreen, type ChosenSlot, createScreenEditing, type ScreenEditing, type ScreenEditingHub, type ScreenRunner, type ScreensPort } from "./screenEditing";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hubs = new WeakMap<QueryClient, ScreenEditingHub>();
const windowEditings = new WeakMap<ScreenEditingHub, Map<WindowId, ScreenEditing>>();

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

const hubFor = (client: QueryClient): ScreenEditingHub => {
  const known = hubs.get(client);
  if (known) return known;
  const hub = createScreenEditing({ screens: queryScreens(client), runner: storeRunner(client) });
  hubs.set(client, hub);
  return hub;
};

const windowSlot = (window: WindowId): ChosenSlot => ({
  get: () => {
    const state = useLayoutStore.getState().layout.windows.find((w) => w.id === window);
    return state?.kind === "screener" ? state.screen ?? null : null;
  },
  set: (id) => useLayoutStore.getState().setWindowScreen(window, id),
});

export function screenEditingFor(client: QueryClient, window: WindowId | null = null): ScreenEditing {
  const hub = hubFor(client);
  if (window === null) return hub;
  const byWindow = windowEditings.get(hub) ?? new Map<WindowId, ScreenEditing>();
  windowEditings.set(hub, byWindow);
  const known = byWindow.get(window);
  if (known) return known;
  const bound = hub.over(windowSlot(window));
  const editing: ScreenEditing = {
    ...bound,
    subscribe: (listener) => {
      const stopEditing = bound.subscribe(listener);
      const stopLayout = useLayoutStore.subscribe(listener);
      return () => {
        stopEditing();
        stopLayout();
      };
    },
  };
  byWindow.set(window, editing);
  return editing;
}

export const firstScreenerWindow = (): WindowId | null => useLayoutStore.getState().layout.windows.find((w) => w.kind === "screener")?.id ?? null;

export async function removeChosen(editing: ScreenEditing, chosen: ChosenScreen): Promise<boolean> {
  if (!await confirmAction(`"${chosen.draft.name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`, { action: "조건식 지우기", danger: true })) return false;
  if (!await editing.remove()) return false;
  dropPendingOpen();
  return true;
}

export function useScreenEditing(window: WindowId | null) {
  const editing = screenEditingFor(useQueryClient(), window);
  const query = useScreens();
  useScreenerStore((s) => s.runs);
  const view = useSyncExternalStore(editing.subscribe, editing.view, editing.view);
  return { editing, view, query };
}
