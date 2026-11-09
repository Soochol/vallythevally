import type { LayoutInput } from "../api/generated/LayoutInput";
import type { Watchlist } from "../api/generated/Watchlist";
import { layoutPath, UI_STATE_PATH, WATCHLIST_PATH } from "../api/userData";
import { useLayoutStore } from "../stores/layout";
import { type SaveTarget, usePersistStore } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { exceedsLimit } from "./bytes";
import { createSaver, type Saver } from "./saver";
import { toUiState } from "./uiState";

const DEBOUNCE_MS = 1000;
export const RECENT_CLEARED = "최근 본 종목 기록을 지웠습니다";

export interface AutosaveDeps {
  /** 이미 직렬화한 본문을 PUT한다. */
  put(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  toast(text: string): void;
}

export interface Autosave {
  savers: Record<SaveTarget, Saver>;
  /** 실패한 저장을 다시 보낸다(상태 줄의 다시 시도 버튼). */
  retry(): void;
  /** 보내지 못한 편집을 keepalive로 지금 보낸다(탭이 숨을 때). */
  flush(): void;
  stop(): void;
}

let active: Autosave | null = null;

export function retryFailedSaves() {
  active?.retry();
}

/**
 * 세 스토어의 편집(`revision`)을 지켜보고 자료마다 PUT으로 통째 저장한다(frontend.md §3.7).
 * 레이아웃과 UiState는 마지막 편집 1초 뒤, 관심종목은 곧바로 보낸다. 스토어의 `load`는 저장을 부르지 않는다.
 */
export function startAutosave(deps: AutosaveDeps): Autosave {
  const setSave = usePersistStore.getState().setSave;

  const layout = createSaver<LayoutInput>({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { id, name, arrangement, sync, cells } = useLayoutStore.getState().layout;
      return { id, name, arrangement, sync, cells };
    },
    // 서버는 칸마다 chartSettings를 64KB로 막는다.
    tooLarge: (l) => l.cells.some((c) => exceedsLimit(c.chartSettings)),
    send: (json, o) => deps.put(layoutPath(useLayoutStore.getState().layout.id), json, o),
    onState: (s) => setSave("layout", s),
  });

  const ui = createSaver({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { prefs, extra } = useUiStore.getState();
      return toUiState(prefs, extra);
    },
    tooLarge: exceedsLimit,
    // 화면이 스스로 줄일 수 있는 것은 최근 본 종목뿐이다(frontend.md §3.7a).
    shrink: () => {
      const store = useUiStore.getState();
      if (store.prefs.recentSymbols.length === 0) return false;
      store.clearRecent();
      deps.toast(RECENT_CLEARED);
      return true;
    },
    send: (json, o) => deps.put(UI_STATE_PATH, json, o),
    onState: (s) => setSave("ui", s),
  });

  const watchlist = createSaver<Watchlist>({
    debounceMs: 0,
    read: () => ({ symbols: [...useWatchlistStore.getState().symbols] }),
    tooLarge: () => false,
    send: (json, o) => deps.put(WATCHLIST_PATH, json, o),
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
