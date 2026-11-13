import { create } from "zustand";
import type { KstDate } from "../api/generated/KstDate";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerResult } from "../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import { ApiRequestError } from "../api/http";
import { runScreen } from "../api/screener";
import { DEFAULT_SORT, isUpdating, type ResultSort } from "../lib/screener";

interface CompletedRun {
  result: ScreenerResult;
  storeVersion: number;
}

export type ScreenRun =
  | { kind: "running"; screen: Screen; key: string; shown: CompletedRun | null }
  | ({ kind: "done"; screen: Screen; key: string } & CompletedRun)
  | { kind: "failed"; screen: Screen; key: string; shown: CompletedRun | null; error: ApiRequestError };

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

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, field]) => [key, canonical(field)]));
};

export const screenKey = (screen: Screen) => JSON.stringify(canonical(screen));

const matching = (run: ScreenRun | undefined, key: string) => (run?.key === key ? run : null);

export const runOf = (runs: ScreenerState["runs"], screen: Screen): ScreenRun | null => matching(runs[screen.id], screenKey(screen));

function completedRun(run: ScreenRun | null): CompletedRun | null {
  if (run?.kind === "done") return run;
  return run?.shown ?? null;
}

export function shownResult(run: ScreenRun | null): ScreenerResult | null {
  return completedRun(run)?.result ?? null;
}

export function rerunReason(run: ScreenRun | null, storeVersion: number, status: ScreenerStatus | undefined): Rerun | null {
  const completed = completedRun(run);
  if (completed === null || status === undefined) return null;
  if (status.lastDay !== null && status.lastDay > completed.result.asOf) return { kind: "new_day", day: status.lastDay };
  return completed.storeVersion === storeVersion ? null : { kind: "store_changed" };
}

const seenOf = ({ lastDay, fullHistory, unconfirmed }: ScreenerStatus, updating: boolean): SeenStore => ({
  contents: `${lastDay}|${fullHistory.done}|${fullHistory.total}|${unconfirmed}`,
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
      const snapshot = structuredClone(screen);
      const key = screenKey(snapshot);
      const storeVersion = get().storeVersion;
      const pending: ScreenRun = { kind: "running", screen: snapshot, key, shown: completedRun(matching(get().runs[snapshot.id], key)) };
      record(pending);
      try {
        const result = await runScreen(snapshot);
        if (get().runs[snapshot.id] === pending) record({ kind: "done", screen: snapshot, key, result, storeVersion });
      } catch (e) {
        if (get().runs[snapshot.id] === pending) record({ kind: "failed", screen: snapshot, key, shown: pending.shown, error: asApiError(e) });
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
