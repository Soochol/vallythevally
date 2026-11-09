import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { addSymbol, moveSymbol, moveSymbolBy, removeSymbol } from "../lib/watchlist";

interface WatchlistState {
  symbols: readonly SymbolCode[];
  revision: number;
  load(symbols: readonly SymbolCode[]): void;
  add(code: SymbolCode): void;
  remove(code: SymbolCode): void;
  move(code: SymbolCode, to: number): void;
  moveBy(code: SymbolCode, step: -1 | 1): void;
}

export const useWatchlistStore = create<WatchlistState>()((set) => {
  const edit = (f: (l: readonly SymbolCode[]) => readonly SymbolCode[]) =>
    set((s) => {
      const symbols = f(s.symbols);
      return symbols === s.symbols ? s : { symbols, revision: s.revision + 1 };
    });
  return {
    symbols: [],
    revision: 0,
    load: (symbols) => set({ symbols }),
    add: (code) => edit((l) => addSymbol(l, code)),
    remove: (code) => edit((l) => removeSymbol(l, code)),
    move: (code, to) => edit((l) => moveSymbol(l, code, to)),
    moveBy: (code, step) => edit((l) => moveSymbolBy(l, code, step)),
  };
});
