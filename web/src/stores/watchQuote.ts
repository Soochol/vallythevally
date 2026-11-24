import { useCallback, useSyncExternalStore } from "react";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WatchQuote } from "./quoteBook";
import { quoteBook } from "./realtime";

export function useWatchQuote(code: SymbolCode): WatchQuote {
  const subscribe = useCallback((listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  return useSyncExternalStore(subscribe, () => quoteBook.get(code));
}
