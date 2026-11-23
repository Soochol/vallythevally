import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setPageSlot(next: HTMLElement | null): void {
  if (slot === next) return;
  slot = next;
  for (const listener of listeners) listener();
}

export function usePageSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => slot,
    () => null,
  );
}
