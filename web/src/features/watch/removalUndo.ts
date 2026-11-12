import { fetchWatchlists } from "../../api/userData";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { usePersistStore } from "../../stores/persist";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";

const saving = () => {
  const state = usePersistStore.getState().saves.watchlist;
  return state.kind === "pending" || state.kind === "saving";
};

function waitForSave(): Promise<void> {
  if (!saving()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = usePersistStore.subscribe(() => {
      if (saving()) return;
      unsubscribe();
      resolve();
    });
  });
}

export function removeWithUndo(list: string, code: SymbolCode): ToastUndo | null {
  const action = useWatchlistStore.getState().removeWithUndo(list, code);
  if (!action) return null;
  let used = false;
  let request = 0;
  const available = () => !used && action.available();
  return {
    available,
    run: () => {
      if (!available()) return;
      used = true;
      request++;
      void (async () => {
        await waitForSave();
        if (!action.available()) return;
        const latest = await fetchWatchlists();
        if (!action.available()) return;
        useWatchlistStore.getState().load(latest.lists);
        action.run();
      })().catch(() => useSelectionStore.getState().showToast("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요"));
    },
    subscribe: (listener) => {
      let active = true;
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
      const interval = setInterval(check, 1000);
      check();
      return () => {
        active = false;
        unsubscribe();
        window.removeEventListener("focus", check);
        clearInterval(interval);
      };
    },
  };
}
