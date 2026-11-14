import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Watchlist } from "../api/generated/Watchlist";
import {
  addSymbol,
  addSymbols,
  addToGroup,
  moveToGroup,
  removeRow,
  type WatchRowRef,
  createGroup,
  DEFAULT_WATCHLISTS,
  deleteGroup,
  duplicateWatchlist,
  MAX_WATCHLISTS,
  listNameFrom,
  moveGroupBy,
  moveSymbol,
  moveSymbolBy,
  removeSymbol,
  renameGroup,
  sameWatchlist,
  type Transfer,
  transferSymbol,
  ungroup,
} from "../lib/watchlist";
import { useUiStore } from "./ui";
import type { ToastUndo } from "./selection";

export interface WatchlistRemoval extends Omit<ToastUndo, "run"> {
  restore(lists: readonly Watchlist[], allowRestored?: boolean): Watchlist[] | null;
}

interface WatchlistState {
  lists: readonly Watchlist[];
  revision: number;
  loadedRevision: number | null;
  load(lists: readonly Watchlist[], revision?: number): void;
  create(id: string, name: string): void;
  duplicate(source: string, id: string): void;
  rename(id: string, name: string): void;
  removeList(id: string): void;
  add(list: string, code: SymbolCode): void;
  addAll(list: string, codes: readonly SymbolCode[]): void;
  remove(list: string, code: SymbolCode): void;
  removeFromListWithUndo(list: string, code: SymbolCode): WatchlistRemoval | null;
  removeRowWithUndo(list: string, row: WatchRowRef): WatchlistRemoval | null;
  move(list: string, row: WatchRowRef, to: number): void;
  moveBy(list: string, row: WatchRowRef, step: -1 | 1): void;
  transfer(from: string, to: string, row: WatchRowRef, how: Transfer): void;
  createGroup(list: string, id: string, name: string, codes?: readonly SymbolCode[]): void;
  renameGroup(list: string, id: string, name: string): void;
  moveGroupBy(list: string, id: string, step: -1 | 1): void;
  ungroup(list: string, id: string): void;
  deleteGroup(list: string, id: string): void;
  addToGroup(list: string, code: SymbolCode, group: string): void;
  moveToGroup(list: string, row: WatchRowRef, group: string): void;
}

export const useWatchlistStore = create<WatchlistState>()((set, get) => {
  const edit = (f: (lists: readonly Watchlist[]) => readonly Watchlist[]) =>
    set((s) => {
      const lists = f(s.lists);
      return lists === s.lists ? s : { lists, revision: s.revision + 1 };
    });
  const editList = (id: string, f: (list: Watchlist) => Watchlist) =>
    edit((lists) => {
      const i = lists.findIndex((l) => l.id === id);
      const next = i < 0 ? undefined : f(lists[i]!);
      if (next === undefined || next === lists[i]) return lists;
      return lists.map((l, j) => (j === i ? next : l));
    });
  const editSymbols = (id: string, f: (symbols: readonly SymbolCode[]) => readonly SymbolCode[]) =>
    editList(id, (l) => {
      const symbols = f(l.symbols);
      return symbols === l.symbols ? l : { ...l, symbols: [...symbols] };
    });
  const removeWithUndo = (list: string, transform: (list: Watchlist) => Watchlist): WatchlistRemoval | null => {
    const source = get().lists.find((l) => l.id === list);
    if (!source) return null;
    const after = transform(source);
    if (after === source) return null;
    editList(list, () => after);
    const revision = get().revision;
    const available = () => get().revision === revision && get().lists.includes(after);
    return {
      available,
      restore: (lists, allowRestored = false) => {
        if (!available()) return null;
        const target = lists.find((l) => l.id === list);
        if (!target) return null;
        if (allowRestored && sameWatchlist(target, source)) return [...lists];
        if (!sameWatchlist(target, after)) return null;
        return lists.map((l) => l.id === list ? source : l);
      },
      subscribe: (listener) => useWatchlistStore.subscribe(listener),
    };
  };
  return {
    lists: DEFAULT_WATCHLISTS,
    revision: 0,
    loadedRevision: null,
    load: (lists, revision) => set((s) => {
      const next = lists.map((incoming) => {
        const current = s.lists.find((l) => l.id === incoming.id);
        return current && sameWatchlist(current, incoming) ? current : incoming;
      });
      return next.length === s.lists.length && next.every((l, i) => l === s.lists[i]) && (revision === undefined || (revision === s.revision && revision === s.loadedRevision))
        ? s : { lists: next, ...(revision === undefined ? {} : { revision, loadedRevision: revision }) };
    }),
    create: (id, name) => edit((lists) => (lists.length >= MAX_WATCHLISTS ? lists : [...lists, { id, name, symbols: [], groups: [] }])),
    duplicate: (source, id) => edit((lists) => {
      const original = lists.find((l) => l.id === source);
      if (!original || lists.length >= MAX_WATCHLISTS) return lists;
      return [...lists, duplicateWatchlist(original, id, listNameFrom(lists, `${original.name} 복사`), () => crypto.randomUUID())];
    }),
    rename: (id, name) => edit((lists) => (lists.some((l) => l.id === id && l.name !== name) ? lists.map((l) => (l.id === id ? { ...l, name } : l)) : lists)),
    removeList: (id) => edit((lists) => (lists.length <= 1 || !lists.some((l) => l.id === id) ? lists : lists.filter((l) => l.id !== id))),
    add: (list, code) => editSymbols(list, (l) => addSymbol(l, code)),
    addAll: (list, codes) => editSymbols(list, (l) => addSymbols(l, codes)),
    remove: (list, code) => editList(list, (l) => removeSymbol(l, code)),
    removeFromListWithUndo: (list, code) => removeWithUndo(list, (l) => removeSymbol(l, code)),
    removeRowWithUndo: (list, row) => removeWithUndo(list, (l) => removeRow(l, row)),
    move: (list, row, to) => editList(list, (l) => moveSymbol(l, row, to)),
    moveBy: (list, row, step) => editList(list, (l) => moveSymbolBy(l, row, step)),
    transfer: (from, to, row, how) => edit((lists) => transferSymbol(lists, from, to, row, how)),
    createGroup: (list, id, name, codes) => editList(list, (l) => createGroup(l, id, name, codes)),
    renameGroup: (list, id, name) => editList(list, (l) => renameGroup(l, id, name)),
    moveGroupBy: (list, id, step) => editList(list, (l) => moveGroupBy(l, id, step)),
    ungroup: (list, id) => editList(list, (l) => ungroup(l, id)),
    deleteGroup: (list, id) => editList(list, (l) => deleteGroup(l, id)),
    addToGroup: (list, code, group) => editList(list, (l) => addToGroup(l, code, group)),
    moveToGroup: (list, row, group) => editList(list, (l) => moveToGroup(l, row, group)),
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
