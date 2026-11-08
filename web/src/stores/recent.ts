import { create } from "zustand";
import type { SymbolInfo } from "../api/generated/SymbolInfo";

const MAX_RECENT = 10;

/** 최근 본 종목. 최근 것 먼저, 최대 10개. #2에서는 메모리에만 둔다(#3부터 UiState.recentSymbols). */
interface RecentState {
  recent: SymbolInfo[];
  push(info: SymbolInfo): void;
}

export const useRecentStore = create<RecentState>()((set) => ({
  recent: [],
  push: (info) =>
    set((s) => ({ recent: [info, ...s.recent.filter((r) => r.code !== info.code)].slice(0, MAX_RECENT) })),
}));
