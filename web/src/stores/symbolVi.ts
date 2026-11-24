import { useCallback, useSyncExternalStore } from "react";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { ViState } from "../api/generated/ViState";
import { viBook } from "./realtime";

const subscribeKnown = (listener: () => void) => viBook.subscribeKnown(listener);
const getKnown = () => viBook.isKnown();

export function useSymbolVi(code: SymbolCode): ViState | null {
  const subscribe = useCallback((listener: () => void) => viBook.subscribe(code, listener), [code]);
  return useSyncExternalStore(subscribe, () => viBook.get(code));
}

export function useViKnown(): boolean {
  return useSyncExternalStore(subscribeKnown, getKnown);
}
