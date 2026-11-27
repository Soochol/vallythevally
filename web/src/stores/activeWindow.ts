import { windowId, type WindowId } from "../layout/kinds";

type TouchListener = (id: WindowId) => void;

let lastClicked: WindowId | null = null;
const mountedWatchWindows = new Set<WindowId>();
const touchListeners = new Set<TouchListener>();

interface WindowHostElement {
  readonly dataset: Record<string, string | undefined>;
  closest(selector: string): WindowHostElement | null;
  querySelector(selector: string): WindowHostElement | null;
}

function isWindowHostElement(target: EventTarget | null): target is EventTarget & WindowHostElement {
  const elementCtor = (globalThis as { Element?: abstract new (...args: never[]) => unknown }).Element;
  return typeof elementCtor === "function" && target instanceof elementCtor;
}

export function windowIdFromTarget(target: EventTarget | null): WindowId | null {
  if (!isWindowHostElement(target)) return null;
  if (target.closest(".dock-tab-close") !== null) return null;
  const host = target.closest("[data-window-id], [data-canvas-window], [data-dock-float]")
    ?? target.closest(".dock-tab-group[data-selected]")?.querySelector("[data-window-id]")
    ?? null;
  if (!host) return null;
  const id = host.dataset.windowId ?? host.dataset.canvasWindow ?? host.dataset.dockFloat;
  return id ? windowId(id) : null;
}

export function onWindowTouch(listener: TouchListener): () => void {
  touchListeners.add(listener);
  return () => {
    touchListeners.delete(listener);
  };
}

export function touchWindow(id: WindowId) {
  lastClicked = id;
  for (const listener of touchListeners) listener(id);
}

export function touchWindowFromTarget(target: EventTarget | null) {
  const id = windowIdFromTarget(target);
  if (id !== null) touchWindow(id);
}

export function activeWindowId(): WindowId | null {
  return lastClicked;
}

export function clearActiveWindow() {
  lastClicked = null;
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
