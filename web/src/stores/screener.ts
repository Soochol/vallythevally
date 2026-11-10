import { create } from "zustand";
import type { KstDate } from "../api/generated/KstDate";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerResult } from "../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import { ApiRequestError } from "../api/http";
import { runScreen } from "../api/screener";
import { DEFAULT_SORT, isUpdating, type ResultSort } from "../lib/screener";

export type ScreenRun =
  | { kind: "running"; screen: Screen; shown: ScreenerResult | null }
  | { kind: "done"; screen: Screen; result: ScreenerResult; storeVersion: number }
  | { kind: "failed"; screen: Screen; error: ApiRequestError };

export type Rerun = { kind: "new_day"; day: KstDate } | { kind: "store_changed" };

interface SeenStore {
  contents: string;
  updating: boolean;
}

interface ScreenerState {
  chosenId: string | null;
  runs: Readonly<Record<string, ScreenRun>>;
  sort: ResultSort;
  storeVersion: number;
  seen: SeenStore | null;
  choose(id: string): void;
  setSort(sort: ResultSort): void;
  run(screen: Screen): Promise<void>;
  seeStatus(status: ScreenerStatus): void;
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

export function rerunReason(run: ScreenRun | null, storeVersion: number, status: ScreenerStatus | undefined): Rerun | null {
  if (run?.kind !== "done" || status === undefined) return null;
  if (status.lastDay !== null && status.lastDay > run.result.asOf) return { kind: "new_day", day: status.lastDay };
  return run.storeVersion === storeVersion ? null : { kind: "store_changed" };
}

const seenOf = ({ lastDay, fullHistory }: ScreenerStatus, updating: boolean): SeenStore => ({
  contents: `${lastDay}|${fullHistory.done}|${fullHistory.total}`,
  updating,
});

const asApiError = (e: unknown) => (e instanceof ApiRequestError ? e : new ApiRequestError("internal", e instanceof Error ? e.message : String(e)));

export const useScreenerStore = create<ScreenerState>()((set, get) => {
  const record = (run: ScreenRun) => set((s) => ({ runs: { ...s.runs, [run.screen.id]: run } }));
  return {
    chosenId: null,
    runs: {},
    sort: DEFAULT_SORT,
    storeVersion: 0,
    seen: null,
    choose: (chosenId) => set({ chosenId }),
    setSort: (sort) => set({ sort }),
    run: async (screen) => {
      const storeVersion = get().storeVersion;
      record({ kind: "running", screen, shown: shownResult(runOf(get().runs, screen)) });
      try {
        record({ kind: "done", screen, result: await runScreen(screen), storeVersion });
      } catch (e) {
        record({ kind: "failed", screen, error: asApiError(e) });
      }
    },
    seeStatus: (status) =>
      set((s) => {
        const next = seenOf(status, isUpdating(status));
        if (s.seen?.contents === next.contents && s.seen.updating === next.updating) return s;
        const changed = s.seen !== null && (s.seen.contents !== next.contents || (s.seen.updating && !next.updating));
        return { seen: next, storeVersion: s.storeVersion + (changed ? 1 : 0) };
      }),
  };
});
