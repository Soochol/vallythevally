import { windowId, type WindowId } from "../layout/kinds";

let lastClicked: WindowId | null = null;
const mountedWatchWindows = new Set<WindowId>();

export function windowIdFromTarget(target: EventTarget | null): WindowId | null {
  if (!(target instanceof Element)) return null;
  const host = target.closest<HTMLElement>("[data-window-id], [data-canvas-window], [data-dock-float]")
    ?? target.closest<HTMLElement>(".dock-tab-group")?.querySelector<HTMLElement>("[data-window-id]")
    ?? null;
  if (!host) return null;
  const id = host.dataset.windowId ?? host.dataset.canvasWindow ?? host.dataset.dockFloat;
  return id ? windowId(id) : null;
}

export function touchWindow(id: WindowId) {
  lastClicked = id;
}

export function touchWindowFromTarget(target: EventTarget | null) {
  const id = windowIdFromTarget(target);
  if (id !== null) lastClicked = id;
}

export function registerWatchWindow(id: WindowId): () => void {
  mountedWatchWindows.add(id);
  return () => {
    mountedWatchWindows.delete(id);
  };
}

export function activeWatchWindow(): WindowId | null {
  return lastClicked !== null && mountedWatchWindows.has(lastClicked) ? lastClicked : null;
}

export function resetActiveWindow() {
  lastClicked = null;
  mountedWatchWindows.clear();
}
