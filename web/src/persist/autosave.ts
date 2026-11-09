import type { LayoutInput } from "../api/generated/LayoutInput";
import type { Watchlist } from "../api/generated/Watchlist";
import { layoutPath, UI_STATE_PATH, WATCHLIST_PATH } from "../api/userData";
import { useLayoutStore } from "../stores/layout";
import { type SaveTarget, usePersistStore } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { exceedsLimit } from "./bytes";
import { createSaver, type Saver, type SaverOptions } from "./saver";
import { clearUnsaved, writeUnsaved } from "./unsaved";
import { toUiState } from "./uiState";

const DEBOUNCE_MS = 1000;
export const RECENT_CLEARED = "최근 본 종목 기록을 지웠습니다";

export interface AutosaveDeps {
  put(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  toast(text: string): void;
  revisions: Record<SaveTarget, number>;
  unsaved?: (target: SaveTarget) => SaverOptions<object>["unsaved"];
}

export interface Autosave {
  savers: Record<SaveTarget, Saver>;
  retry(): void;
  flush(): void;
  stop(): void;
}

let active: Autosave | null = null;

export function retryFailedSaves() {
  active?.retry();
}

export function startAutosave(deps: AutosaveDeps): Autosave {
  const setSave = usePersistStore.getState().setSave;
  const unsaved =
    deps.unsaved ?? ((target: SaveTarget) => ({ write: (u) => writeUnsaved(target, u), clear: (upTo) => clearUnsaved(target, upTo) }));

  const layout = createSaver<Omit<LayoutInput, "revision">>({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { id, name, arrangement, sync, cells } = useLayoutStore.getState().layout;
      return { id, name, arrangement, sync, cells };
    },
    // 서버는 칸마다 chartSettings를 64KB로 막는다.
    tooLarge: (l) => l.cells.some((c) => exceedsLimit(c.chartSettings)),
    path: () => layoutPath(useLayoutStore.getState().layout.id),
    revision: deps.revisions.layout,
    send: deps.put,
    unsaved: unsaved("layout"),
    onState: (s) => setSave("layout", s),
  });

  const ui = createSaver({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { prefs, extra } = useUiStore.getState();
      return toUiState(prefs, extra);
    },
    // 서버는 revision까지 담은 본문을 잰다. 가장 긴 revision으로 잰다.
    tooLarge: (v) => exceedsLimit({ ...v, revision: Number.MAX_SAFE_INTEGER }),
    shrink: () => {
      const store = useUiStore.getState();
      if (store.prefs.recentSymbols.length === 0) return false;
      store.clearRecent();
      deps.toast(RECENT_CLEARED);
      return true;
    },
    path: () => UI_STATE_PATH,
    revision: deps.revisions.ui,
    send: deps.put,
    unsaved: unsaved("ui"),
    onState: (s) => setSave("ui", s),
  });

  const watchlist = createSaver<Omit<Watchlist, "revision">>({
    debounceMs: 0,
    read: () => ({ symbols: [...useWatchlistStore.getState().symbols] }),
    tooLarge: () => false,
    path: () => WATCHLIST_PATH,
    revision: deps.revisions.watchlist,
    send: deps.put,
    unsaved: unsaved("watchlist"),
    onState: (s) => setSave("watchlist", s),
  });

  const unsubscribe = [
    useLayoutStore.subscribe((s, prev) => s.revision !== prev.revision && layout.changed()),
    useUiStore.subscribe((s, prev) => s.revision !== prev.revision && ui.changed()),
    useWatchlistStore.subscribe((s, prev) => s.revision !== prev.revision && watchlist.changed()),
  ];
  const savers = { layout, ui, watchlist };
  const all = Object.values(savers);
  const autosave: Autosave = {
    savers,
    retry: () => all.forEach((s) => s.retry()),
    flush: () => all.forEach((s) => s.flush()),
    stop: () => {
      unsubscribe.forEach((u) => u());
      if (active === autosave) active = null;
    },
  };
  active = autosave;
  return autosave;
}
