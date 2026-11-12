import { ApiRequestError, putJson } from "../../api/http";
import { fetchWatchlists, WATCHLISTS_PATH } from "../../api/userData";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { acceptWatchlistSave, advanceWatchlistRevision, resumeWatchlistSaves, settleWatchlistSaves } from "../../persist/autosave";
import { clearUnsaved, writeUnsaved } from "../../persist/unsaved";
import { usePersistStore } from "../../stores/persist";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";

const CONFLICT = "다른 곳에서 바뀌어 되돌리지 못했습니다";

export function removeWithUndo(list: string, code: SymbolCode): ToastUndo | null {
  const action = useWatchlistStore.getState().removeWithUndo(list, code);
  if (!action) return null;
  let used = false;
  const available = () => !used && action.available();
  return {
    available,
    run: () => {
      if (!available()) return;
      used = true;
      void (async () => {
        const persist = usePersistStore.getState();
        let previous = persist.saves.watchlist;
        const saving = { kind: "saving" } as const;
        try {
          await settleWatchlistSaves();
          previous = usePersistStore.getState().saves.watchlist;
          const allowRestored = previous.kind === "failed";
          for (let attempt = 0; attempt < 3; attempt++) {
            if (!action.available()) return;
            const latest = await fetchWatchlists();
            if (!action.available()) return;
            const lists = action.restore(latest.lists, allowRestored);
            if (!lists) { useSelectionStore.getState().showToast(CONFLICT); return; }
            const saved = { lists, revision: latest.revision + 1 };
            persist.setSave("watchlist", saving);
            writeUnsaved("watchlist", { path: WATCHLISTS_PATH, revision: saved.revision, body: JSON.stringify(saved) });
            try {
              await putJson(WATCHLISTS_PATH, saved);
            } catch (error) {
              if (error instanceof ApiRequestError && error.code === "stale_revision") {
                clearUnsaved("watchlist", saved.revision);
                continue;
              }
              throw error;
            }
            clearUnsaved("watchlist", saved.revision);
            if (action.available()) acceptWatchlistSave(saved);
            else advanceWatchlistRevision(saved.revision);
            return;
          }
          useSelectionStore.getState().showToast(CONFLICT);
        } finally {
          if (usePersistStore.getState().saves.watchlist === saving) persist.setSave("watchlist", previous);
          resumeWatchlistSaves();
        }
      })().catch(() => useSelectionStore.getState().showToast("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요"));
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
