import { create } from "zustand";
import { stepPeriodAnchor, todayKstIso } from "./journalEngine";
import { loadJournalNotes, saveJournalNotes } from "./journalNotes";
import {
  EMPTY_FILTERS,
  type JournalDistMode,
  type JournalFilterKey,
  type JournalFilters,
  type JournalGrain,
  type JournalMetric,
  type JournalNote,
  type JournalPeriod,
  type JournalPeriodType,
  type JournalQuickFilter,
  type JournalSort,
  type JournalTf,
} from "./journalTypes";

interface JournalStoreState {
  period: JournalPeriod;
  anchorTouched: boolean;
  afterCost: boolean;
  filters: JournalFilters;
  metric: JournalMetric;
  view: "flow" | "cal" | "table";
  grain: JournalGrain;
  distMode: JournalDistMode;
  sort: JournalSort;
  sortDir: 1 | -1;
  quick: JournalQuickFilter;
  selectedId: string | null;
  tf: JournalTf | null;
  demoMode: boolean;
  notes: Record<string, JournalNote>;

  setPeriodType: (type: JournalPeriodType) => void;
  setPeriod: (period: JournalPeriod) => void;
  syncInitialAnchor: (day: string) => void;
  stepPeriod: (dir: -1 | 1, today: string) => void;
  jumpToday: (today: string) => void;
  toggleAfterCost: () => void;
  toggleFilter: <K extends JournalFilterKey>(key: K, value: NonNullable<JournalFilters[K]>) => void;
  setFilter: <K extends JournalFilterKey>(key: K, value: JournalFilters[K]) => void;
  clearFilter: (key: JournalFilterKey | "*") => void;
  setMetric: (metric: JournalMetric) => void;
  setView: (view: "flow" | "cal" | "table") => void;
  setGrain: (grain: JournalGrain) => void;
  setDistMode: (distMode: JournalDistMode) => void;
  setSort: (sort: JournalSort) => void;
  setQuick: (quick: JournalQuickFilter) => void;
  selectTrade: (id: string | null) => void;
  setTf: (tf: JournalTf | null) => void;
  setDemoMode: (on: boolean) => void;
  saveMemo: (tradeId: string, memo: string, fallbackTags: readonly string[]) => void;
  toggleTradeTag: (tradeId: string, tag: string, fallbackMemo: string, fallbackTags: readonly string[]) => void;
}

const defaultGrainFor = (type: JournalPeriodType): JournalGrain =>
  type === "day" ? "sym" : type === "year" || type === "all" ? "month" : "day";

export const useJournalStore = create<JournalStoreState>((set) => ({
  period: { type: "month", anchor: todayKstIso() },
  anchorTouched: false,
  afterCost: true,
  filters: EMPTY_FILTERS,
  metric: "pnl",
  view: "flow",
  grain: "day",
  distMode: "hold",
  sort: "time",
  sortDir: -1,
  quick: "all",
  selectedId: null,
  tf: null,
  demoMode: false,
  notes: loadJournalNotes(),

  setPeriodType: (type) =>
    set((s) => ({
      period: { type, anchor: s.period.anchor },
      grain: defaultGrainFor(type),
    })),

  setPeriod: (period) =>
    set({
      period,
      anchorTouched: true,
      grain: defaultGrainFor(period.type),
    }),

  syncInitialAnchor: (day) =>
    set((s) =>
      s.anchorTouched || day === "" || s.period.anchor === day
        ? s
        : { period: { type: s.period.type, anchor: day } },
    ),

  stepPeriod: (dir, today) =>
    set((s) => ({
      period: { type: s.period.type, anchor: stepPeriodAnchor(s.period, dir, today) },
      anchorTouched: true,
    })),

  jumpToday: (today) =>
    set((s) => ({
      period: { type: s.period.type, anchor: today },
      anchorTouched: true,
    })),

  toggleAfterCost: () => set((s) => ({ afterCost: !s.afterCost })),

  toggleFilter: (key, value) =>
    set((s) => ({
      filters: { ...s.filters, [key]: s.filters[key] === value ? null : value },
    })),

  setFilter: (key, value) =>
    set((s) => ({
      filters: { ...s.filters, [key]: value },
    })),

  clearFilter: (key) =>
    set((s) =>
      key === "*"
        ? { filters: EMPTY_FILTERS, quick: "all" }
        : { filters: { ...s.filters, [key]: null } },
    ),

  setMetric: (metric) => set({ metric }),
  setView: (view) => set({ view }),
  setGrain: (grain) => set({ grain }),
  setDistMode: (distMode) => set({ distMode }),
  setSort: (sort) =>
    set((s) => (s.sort === sort ? { sortDir: s.sortDir === -1 ? 1 : -1 } : { sort, sortDir: -1 })),
  setQuick: (quick) => set({ quick }),
  selectTrade: (id) => set({ selectedId: id, tf: null }),
  setTf: (tf) => set({ tf }),
  setDemoMode: (demoMode) => set({ demoMode, selectedId: null, tf: null }),

  saveMemo: (tradeId, memo, fallbackTags) =>
    set((s) => {
      const prev = s.notes[tradeId];
      const next = { ...s.notes, [tradeId]: { memo, tags: prev?.tags ?? fallbackTags } };
      saveJournalNotes(next);
      return { notes: next };
    }),

  toggleTradeTag: (tradeId, tag, fallbackMemo, fallbackTags) =>
    set((s) => {
      const prev = s.notes[tradeId];
      const current = new Set(prev?.tags ?? fallbackTags);
      if (current.has(tag)) current.delete(tag);
      else current.add(tag);
      const next = {
        ...s.notes,
        [tradeId]: { memo: prev?.memo ?? fallbackMemo, tags: [...current] },
      };
      saveJournalNotes(next);
      return { notes: next };
    }),
}));
