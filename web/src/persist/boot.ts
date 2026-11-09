import type { QueryClient } from "@tanstack/react-query";
import { ApiRequestError, sendJson } from "../api/http";
import { fetchSymbolInfo } from "../api/queries";
import { fetchLayout, fetchLayouts, fetchUiState, fetchWatchlist } from "../api/userData";
import { useLayoutStore } from "../stores/layout";
import { SAVE_TARGETS, usePersistStore } from "../stores/persist";
import { useSelectionStore } from "../stores/selection";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { startAutosave } from "./autosave";
import { restore } from "./restore";
import { clearUnsaved, readUnsaved } from "./unsaved";
import { DEFAULT_UI_PREFS, type Theme } from "./uiState";

// index.html의 인라인 스크립트가 첫 그리기 전에 이 키를 읽는다. 원본은 UiState.theme이고 이것은 그림용 사본이다.
const THEME_STORAGE_KEY = "vv.theme";
export const OFFLINE_MESSAGE = "서버에 연결하지 못해 기본 화면으로 열었습니다. 바꾼 것은 저장하지 않습니다";

function paintTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 저장소를 못 쓰면 다음 첫 그리기만 기본 테마로 시작한다.
  }
}

/** 테마가 바뀌면 문서와 localStorage에 반영한다. */
function followTheme() {
  paintTheme(useUiStore.getState().prefs.theme);
  useUiStore.subscribe((s, prev) => s.prefs.theme !== prev.prefs.theme && paintTheme(s.prefs.theme));
}

/**
 * 첫 화면을 서버에서 되살리고 자동 저장을 켠다. 페이지마다 한 번, React 밖에서 부른다.
 * 끝날 때까지 `phase`는 `restoring`이고 화면은 차트를 그리지 않는다.
 */
export async function boot(queryClient: QueryClient) {
  const { setPhase } = usePersistStore.getState();
  const toast = (text: string) => useSelectionStore.getState().showToast(text);
  try {
    const restored = await restore({
      uiState: () => fetchUiState(),
      layouts: () => fetchLayouts(),
      layout: (id) => fetchLayout(id),
      watchlist: () => fetchWatchlist(),
      // 칸이 곧 같은 키로 종목 정보를 쓴다. 복원을 오래 붙잡지 않도록 다시 묻지 않는다.
      symbolInfo: (code) =>
        queryClient.fetchQuery({
          queryKey: ["symbol", code],
          queryFn: ({ signal }) => fetchSymbolInfo(code, signal),
          staleTime: Infinity,
          retry: false,
        }),
      unsaved: readUnsaved,
    });
    useLayoutStore.getState().load(restored.layout);
    useUiStore.getState().load(restored.ui.prefs, restored.ui.extra);
    useWatchlistStore.getState().load(restored.watchlist);
    followTheme();
    // 서버가 이미 가진 것보다 오래된 미저장 본문은 할 일을 마쳤다. 되살린 본문은 아래 changed()가 새 revision으로 다시 남긴다.
    for (const target of SAVE_TARGETS) clearUnsaved(target, restored.serverRevisions[target]);
    const autosave = startAutosave({ put: (path, json, o) => sendJson("PUT", path, json, o), toast, revisions: restored.revisions });
    if (restored.layoutDirty) autosave.savers.layout.changed();
    if (restored.uiDirty) autosave.savers.ui.changed();
    if (restored.watchlistDirty) autosave.savers.watchlist.changed();
    // 탭을 닫거나 새로고침할 때도 hidden이 온다. 미저장 본문은 편집마다 이미 남겨 두었으므로 여기서는 보내 보기만 한다.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") autosave.flush();
    });
    restored.notices.forEach(toast);
    setPhase({ kind: "ready" });
  } catch (e) {
    console.warn("마지막 화면을 되살리지 못했습니다", e);
    const theme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    useUiStore.getState().load({ ...DEFAULT_UI_PREFS, theme }, {});
    followTheme();
    const reason = e instanceof ApiRequestError ? e.message : String(e);
    setPhase({ kind: "offline", message: `${OFFLINE_MESSAGE} (${reason})` });
    toast(OFFLINE_MESSAGE);
  }
}
