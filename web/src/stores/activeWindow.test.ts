import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { windowId } from "../layout/kinds";
import { activeWatchWindow, activeWindowId, clearActiveWindow, onWindowTouch, registerWatchWindow, resetActiveWindow, touchWindow, touchWindowFromTarget, windowIdFromTarget } from "./activeWindow";

class FakeElement extends EventTarget {
  readonly dataset: Record<string, string | undefined>;
  constructor(
    attrs: Record<string, string> = {},
    private readonly parent: FakeElement | null = null,
    private readonly tabHost: FakeElement | null = null,
    private readonly classes: readonly string[] = [],
  ) {
    super();
    this.dataset = attrs;
  }

  closest(selector: string): FakeElement | null {
    const selectors = selector.split(",").map((part) => part.trim());
    for (let node: FakeElement | null = this; node !== null; node = node.parent) {
      for (const item of selectors) {
        if (item === "[data-window-id]" && node.dataset.windowId !== undefined) return node;
        if (item === "[data-canvas-window]" && node.dataset.canvasWindow !== undefined) return node;
        if (item === "[data-dock-float]" && node.dataset.dockFloat !== undefined) return node;
        if (item === ".dock-tab-close" && node.classes.includes("dock-tab-close")) return node;
        if (item === ".dock-tab-group[data-selected]" && node.tabHost !== null && node.dataset.selected !== undefined) return node;
      }
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return selector === "[data-window-id]" ? this.tabHost : null;
  }
}

beforeEach(() => {
  resetActiveWindow();
  vi.stubGlobal("Element", FakeElement);
});

afterEach(() => {
  resetActiveWindow();
  vi.unstubAllGlobals();
});

test("도킹 패널·도킹 탭·캔버스 창·떠 있는 창에서 창 id를 찾는다", () => {
  const dockPanel = new FakeElement({ windowId: "watchlist" });
  const insidePanel = new FakeElement({}, dockPanel);
  expect(windowIdFromTarget(insidePanel)).toBe(windowId("watchlist"));

  const selectedTabButton = new FakeElement({ windowId: "watchlist-2" });
  const selectedTabGroup = new FakeElement({ selected: "" }, null, selectedTabButton);
  const selectedLinkDot = new FakeElement({}, selectedTabGroup);
  const selectedClose = new FakeElement({}, selectedTabGroup, null, ["dock-tab-close"]);
  expect(windowIdFromTarget(selectedTabButton)).toBe(windowId("watchlist-2"));
  expect(windowIdFromTarget(selectedLinkDot)).toBe(windowId("watchlist-2"));
  expect(windowIdFromTarget(selectedClose)).toBeNull();

  const inactiveTabButton = new FakeElement({ windowId: "trades" });
  const inactiveTabGroup = new FakeElement({}, null, inactiveTabButton);
  const inactiveLinkDot = new FakeElement({}, inactiveTabGroup);
  const inactiveClose = new FakeElement({}, inactiveTabGroup, null, ["dock-tab-close"]);
  expect(windowIdFromTarget(inactiveTabButton)).toBe(windowId("trades"));
  expect(windowIdFromTarget(inactiveLinkDot)).toBeNull();
  expect(windowIdFromTarget(inactiveClose)).toBeNull();

  const canvasFrame = new FakeElement({ canvasWindow: "cell-0" });
  expect(windowIdFromTarget(new FakeElement({}, canvasFrame))).toBe(windowId("cell-0"));

  const floatFrame = new FakeElement({ dockFloat: "screener" });
  expect(windowIdFromTarget(new FakeElement({}, floatFrame))).toBe(windowId("screener"));

  expect(windowIdFromTarget(new FakeElement())).toBeNull();
  expect(windowIdFromTarget(null)).toBeNull();
});

test("마지막으로 누른 창이 열린 관심종목일 때만 그 창 id를 돌려준다", () => {
  const stopFirst = registerWatchWindow(windowId("watchlist"));
  const stopSecond = registerWatchWindow(windowId("watchlist-2"));
  expect(activeWatchWindow()).toBeNull();

  touchWindow(windowId("watchlist"));
  expect(activeWatchWindow()).toBe(windowId("watchlist"));

  touchWindowFromTarget(new FakeElement());
  expect(activeWatchWindow()).toBe(windowId("watchlist"));

  touchWindow(windowId("watchlist-2"));
  expect(activeWatchWindow()).toBe(windowId("watchlist-2"));

  touchWindow(windowId("cell-0"));
  expect(activeWatchWindow()).toBeNull();

  touchWindow(windowId("watchlist"));
  stopFirst();
  expect(activeWatchWindow()).toBeNull();

  stopSecond();
});

test("마지막으로 누른 창 id를 추적하고 구독자에게 알리며 clearActiveWindow는 관심종목 등록을 유지한다", () => {
  const seen: string[] = [];
  const stopListen = onWindowTouch((id) => seen.push(id));
  const stopWatch = registerWatchWindow(windowId("watchlist"));

  expect(activeWindowId()).toBeNull();
  touchWindow(windowId("cell-0"));
  expect(activeWindowId()).toBe(windowId("cell-0"));
  touchWindow(windowId("watchlist"));
  expect(activeWindowId()).toBe(windowId("watchlist"));
  expect(activeWatchWindow()).toBe(windowId("watchlist"));
  expect(seen).toEqual(["cell-0", "watchlist"]);

  clearActiveWindow();
  expect(activeWindowId()).toBeNull();
  expect(activeWatchWindow()).toBeNull();
  touchWindow(windowId("watchlist"));
  expect(activeWatchWindow()).toBe(windowId("watchlist"));

  stopListen();
  stopWatch();
});
