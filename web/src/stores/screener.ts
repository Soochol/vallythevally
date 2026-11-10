import { create } from "zustand";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerResult } from "../api/generated/ScreenerResult";
import { ApiRequestError } from "../api/http";
import { runScreen } from "../api/screener";
import { DEFAULT_SORT, type ResultSort } from "../lib/screener";

export type ScreenRun =
  | { kind: "running"; screen: Screen; shown: ScreenerResult | null }
  | { kind: "done"; screen: Screen; result: ScreenerResult }
  | { kind: "failed"; screen: Screen; error: ApiRequestError };

interface ScreenerState {
  chosenId: string | null;
  runs: Readonly<Record<string, ScreenRun>>;
  sort: ResultSort;
  choose(id: string): void;
  setSort(sort: ResultSort): void;
  run(screen: Screen): Promise<void>;
}

const sameScreen = (a: Screen, b: Screen) => JSON.stringify(a) === JSON.stringify(b);

export function runOf(runs: ScreenerState["runs"], screen: Screen): ScreenRun | null {
  const run = runs[screen.id];
  return run && sameScreen(run.screen, screen) ? run : null;
}

export function shownResult(run: ScreenRun | null): ScreenerResult | null {
  if (run?.kind === "done") return run.result;
  return run?.kind === "running" ? run.shown : null;
}

const asApiError = (e: unknown) => (e instanceof ApiRequestError ? e : new ApiRequestError("internal", e instanceof Error ? e.message : String(e)));

export const useScreenerStore = create<ScreenerState>()((set, get) => {
  const record = (run: ScreenRun) => set((s) => ({ runs: { ...s.runs, [run.screen.id]: run } }));
  return {
    chosenId: null,
    runs: {},
    sort: DEFAULT_SORT,
    choose: (chosenId) => set({ chosenId }),
    setSort: (sort) => set({ sort }),
    run: async (screen) => {
      record({ kind: "running", screen, shown: shownResult(runOf(get().runs, screen)) });
      try {
        record({ kind: "done", screen, result: await runScreen(screen) });
      } catch (e) {
        record({ kind: "failed", screen, error: asApiError(e) });
      }
    },
  };
});
