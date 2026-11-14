import { fetchWatchlists } from "../../api/userData";
import type { WatchlistRemoval } from "../../stores/watchlist";
import { commitWatchlist } from "../../persist/autosave";
import { usePersistStore } from "../../stores/persist";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";

const CONFLICT = "다른 곳에서 바뀌어 되돌리지 못했습니다";

export function removalUndo(action: WatchlistRemoval | null): ToastUndo | null {
  if (!action) return null;
  let used = false;
  const available = () => !used && action.available();
  return {
    available,
    run: () => {
      if (!available()) return;
      used = true;
      void commitWatchlist({
        next: (latest, previous) => {
          const lists = action.restore(latest.lists, previous.kind === "failed");
          return lists && { lists };
        },
        still: action.available,
      }).then(
        (outcome) => { if (outcome === "conflict") useSelectionStore.getState().showToast(CONFLICT); },
        () => useSelectionStore.getState().showToast("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요"),
      );
    },
    subscribe: (listener) => {
      let active = true;
      let request = 0;
      const refresh = async () => {
        const state = usePersistStore.getState().saves.watchlist;
        if (!available() || (state.kind !== "idle" && state.kind !== "saved")) return;
        const id = ++request;
        try {
          const latest = await fetchWatchlists();
          if (active && available() && id === request) useWatchlistStore.getState().load(latest.lists);
        } catch {}
      };
      const check = () => { void refresh(); };
      const unsubscribe = action.subscribe(listener);
      window.addEventListener("focus", check);
      window.addEventListener("storage", check);
      check();
      return () => {
        active = false;
        unsubscribe();
        window.removeEventListener("focus", check);
        window.removeEventListener("storage", check);
      };
    },
  };
}
