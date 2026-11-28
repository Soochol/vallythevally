const STORAGE_KEY = "vally.chart.legend.indicators-open";

let pinnedOpen: boolean | null = null;
const listeners = new Set<() => void>();

function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function resetIndicatorsPinnedCache(): void {
  pinnedOpen = null;
}

export function indicatorsPinnedOpen(): boolean {
  pinnedOpen ??= stored();
  return pinnedOpen;
}

export function setIndicatorsPinnedOpen(open: boolean): void {
  if (indicatorsPinnedOpen() === open) return;
  pinnedOpen = open;
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    pinnedOpen = open;
  }
  for (const listener of [...listeners]) listener();
}

export function onIndicatorsPinnedChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
