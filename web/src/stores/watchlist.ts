import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Watchlist } from "../api/generated/Watchlist";
import {
  addSymbol,
  addSymbols,
  DEFAULT_WATCHLISTS,
  MAX_WATCHLISTS,
  listNameFrom,
  moveSymbol,
  moveSymbolBy,
  removeSymbol,
  type Transfer,
  transferSymbol,
} from "../lib/watchlist";
import { useUiStore } from "./ui";
import type { ToastUndo } from "./selection";

interface WatchlistState {
  lists: readonly Watchlist[];
  revision: number;
  load(lists: readonly Watchlist[]): void;
  create(id: string, name: string): void;
  duplicate(source: string, id: string): void;
  rename(id: string, name: string): void;
  removeList(id: string): void;
  add(list: string, code: SymbolCode): void;
  addAll(list: string, codes: readonly SymbolCode[]): void;
  remove(list: string, code: SymbolCode): void;
  removeWithUndo(list: string, code: SymbolCode): ToastUndo | null;
  move(list: string, code: SymbolCode, to: number): void;
  moveBy(list: string, code: SymbolCode, step: -1 | 1): void;
  transfer(from: string, to: string, code: SymbolCode, how: Transfer): void;
}

export const useWatchlistStore = create<WatchlistState>()((set, get) => {
  const edit = (f: (lists: readonly Watchlist[]) => readonly Watchlist[]) =>
    set((s) => {
      const lists = f(s.lists);
      return lists === s.lists ? s : { lists, revision: s.revision + 1 };
    });
  const editSymbols = (id: string, f: (symbols: readonly SymbolCode[]) => readonly SymbolCode[]) =>
    edit((lists) => {
      const i = lists.findIndex((l) => l.id === id);
      const symbols = i < 0 ? undefined : f(lists[i]!.symbols);
      if (symbols === undefined || symbols === lists[i]!.symbols) return lists;
      return lists.map((l, j) => (j === i ? { ...l, symbols: [...symbols] } : l));
    });
  return {
    lists: DEFAULT_WATCHLISTS,
    revision: 0,
    load: (lists) => set({ lists }),
    create: (id, name) => edit((lists) => (lists.length >= MAX_WATCHLISTS ? lists : [...lists, { id, name, symbols: [] }])),
    duplicate: (source, id) => edit((lists) => {
      const original = lists.find((l) => l.id === source);
      if (!original || lists.length >= MAX_WATCHLISTS) return lists;
      return [...lists, { id, name: listNameFrom(lists, `${original.name} 복사`), symbols: [...original.symbols] }];
    }),
    rename: (id, name) => edit((lists) => (lists.some((l) => l.id === id && l.name !== name) ? lists.map((l) => (l.id === id ? { ...l, name } : l)) : lists)),
    removeList: (id) => edit((lists) => (lists.length <= 1 || !lists.some((l) => l.id === id) ? lists : lists.filter((l) => l.id !== id))),
    add: (list, code) => editSymbols(list, (l) => addSymbol(l, code)),
    addAll: (list, codes) => editSymbols(list, (l) => addSymbols(l, codes)),
    remove: (list, code) => editSymbols(list, (l) => removeSymbol(l, code)),
    removeWithUndo: (list, code): ToastUndo | null => {
      const before = get().lists;
      get().remove(list, code);
      const after = get().lists;
      if (before === after) return null;
      const available = () => get().lists === after;
      return {
        available,
        run: () => { if (available()) edit(() => before); },
        subscribe: (listener) => useWatchlistStore.subscribe(listener),
      };
    },
    move: (list, code, to) => editSymbols(list, (l) => moveSymbol(l, code, to)),
    moveBy: (list, code, step) => editSymbols(list, (l) => moveSymbolBy(l, code, step)),
    transfer: (from, to, code, how) => edit((lists) => transferSymbol(lists, from, to, code, how)),
  };
});

export function activeWatchlist(lists: readonly Watchlist[], activeId: string | null): Watchlist {
  return lists.find((l) => l.id === activeId) ?? lists[0]!;
}

export function useActiveWatchlist(): Watchlist {
  const lists = useWatchlistStore((s) => s.lists);
  const activeId = useUiStore((s) => s.prefs.activeWatchlistId);
  return activeWatchlist(lists, activeId);
}
