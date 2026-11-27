import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { windowId } from "../layout/kinds";
import { DEFAULT_LAYOUT, linkedWindowSymbol, useLayoutStore } from "./layout";
import { addSymbolToTapeMatrix, loadTapeMatrixConfig } from "../features/tape-matrix/TapeMatrixWindow";
import { applySymbolDrop, isSymbolDropKind, useSymbolDragStore } from "./symbolDrag";

function installMemoryStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  });
}

describe("symbolDrag", () => {
  beforeEach(() => {
    installMemoryStorage();
    useSymbolDragStore.getState().end();
    useLayoutStore.getState().load({
      ...DEFAULT_LAYOUT,
      windows: [
        { id: windowId("chart-a1"), link: "a", kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("chart-a2"), link: "a", kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("chart-b1"), link: "b", kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("order-b"), link: "b", kind: "order", venue: "krx" },
        { id: windowId("book-b-pinned"), link: "b", kind: "book", symbol: "035420" },
        { id: windowId("chart-none"), link: null, kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("brokers-none"), link: null, kind: "brokers" },
        { id: windowId("watchlist"), link: "a", kind: "watchlist" },
        { id: windowId("scanner"), link: null, kind: "scanner" },
        { id: windowId("tape_matrix"), link: null, kind: "tape_matrix" },
      ],
    });
  });

  it("allows drops only on follows windows and tape_matrix", () => {
    expect(isSymbolDropKind("chart")).toBe(true);
    expect(isSymbolDropKind("book")).toBe(true);
    expect(isSymbolDropKind("order")).toBe(true);
    expect(isSymbolDropKind("brokers")).toBe(true);
    expect(isSymbolDropKind("trades")).toBe(true);
    expect(isSymbolDropKind("program")).toBe(true);
    expect(isSymbolDropKind("premarket")).toBe(true);
    expect(isSymbolDropKind("tape_matrix")).toBe(true);
    expect(isSymbolDropKind("watchlist")).toBe(false);
    expect(isSymbolDropKind("scanner")).toBe(false);
    expect(isSymbolDropKind("screener")).toBe(false);
    expect(isSymbolDropKind("indicators")).toBe(false);
  });

  it("updates all charts in the same link group without detaching", () => {
    const res = useLayoutStore.getState().dropSymbolOnWindow(windowId("chart-a1"), { code: "000660", name: "SK하이닉스" });
    expect(res.changed).toEqual([windowId("chart-a1"), windowId("chart-a2")]);
    const windows = useLayoutStore.getState().layout.windows;
    const c1 = windows.find((w) => w.id === windowId("chart-a1"));
    const c2 = windows.find((w) => w.id === windowId("chart-a2"));
    expect(c1 && c1.kind === "chart" ? { symbol: c1.symbol, link: c1.link } : null).toEqual({ symbol: "000660", link: "a" });
    expect(c2 && c2.kind === "chart" ? { symbol: c2.symbol, link: c2.link } : null).toEqual({ symbol: "000660", link: "a" });
  });

  it("updates the whole link group when dropping on an unpinned linked auxiliary window without auto-pinning", () => {
    useLayoutStore.getState().dropSymbolOnWindow(windowId("order-b"), { code: "000660", name: "SK하이닉스" });
    const layout = useLayoutStore.getState().layout;
    const chartB = layout.windows.find((w) => w.id === windowId("chart-b1"));
    const orderB = layout.windows.find((w) => w.id === windowId("order-b"));
    expect(chartB && chartB.kind === "chart" ? chartB.symbol : null).toBe("000660");
    expect(orderB && orderB.kind === "order" ? orderB.symbol : null).toBeUndefined();
    expect(linkedWindowSymbol(layout, windowId("order-b"), windowId("chart-a1"))).toBe("000660");
    expect(linkedWindowSymbol(layout, windowId("book-b-pinned"), windowId("chart-a1"))).toBe("035420");
  });

  it("ignores drops directly on an explicitly pinned linked window", () => {
    const res = useLayoutStore.getState().dropSymbolOnWindow(windowId("book-b-pinned"), { code: "000660", name: "SK하이닉스" });
    expect(res.changed).toEqual([]);
    const layout = useLayoutStore.getState().layout;
    const chartB = layout.windows.find((w) => w.id === windowId("chart-b1"));
    const bookPinned = layout.windows.find((w) => w.id === windowId("book-b-pinned"));
    expect(chartB && chartB.kind === "chart" ? chartB.symbol : null).toBe("005930");
    expect(bookPinned && bookPinned.kind === "book" ? bookPinned.symbol : null).toBe("035420");
  });

  it("updates only the target window when ungrouped", () => {
    useLayoutStore.getState().dropSymbolOnWindow(windowId("chart-none"), { code: "000660", name: "SK하이닉스" });
    useLayoutStore.getState().dropSymbolOnWindow(windowId("brokers-none"), { code: "035420", name: "NAVER" });
    const windows = useLayoutStore.getState().layout.windows;
    const chartNone = windows.find((w) => w.id === windowId("chart-none"));
    const brokersNone = windows.find((w) => w.id === windowId("brokers-none"));
    expect(chartNone && chartNone.kind === "chart" ? { symbol: chartNone.symbol, link: chartNone.link } : null).toEqual({ symbol: "000660", link: null });
    expect(brokersNone && brokersNone.kind === "brokers" ? { symbol: brokersNone.symbol, link: brokersNone.link } : null).toEqual({ symbol: "035420", link: null });
  });

  it("adds symbols to tape_matrix and reports duplicates", () => {
    const id = windowId("tape_matrix");
    expect(addSymbolToTapeMatrix(id, "005380")).toBe("added");
    expect(loadTapeMatrixConfig(id).symbols).toContain("005380");
    expect(addSymbolToTapeMatrix(id, "005380")).toBe("duplicate");
  });

  it("applies tape_matrix drop through applySymbolDrop", () => {
    const id = windowId("tape_matrix");
    applySymbolDrop(id, "tape_matrix", { code: "012450", name: "한화에어로스페이스", sourceWindow: windowId("watchlist") }, "panel");
    expect(loadTapeMatrixConfig(id).symbols).toContain("012450");
  });

  it("updates a chartless link group through sendSymbol and linkedWindowSymbol", () => {
    useLayoutStore.getState().load({
      ...DEFAULT_LAYOUT,
      windows: [
        { id: windowId("chart-a1"), link: "a", kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("book-c1"), link: "c", kind: "book" },
        { id: windowId("brokers-c1"), link: "c", kind: "brokers" },
        { id: windowId("scanner-c"), link: "c", kind: "scanner" },
      ],
    });
    const res = useLayoutStore.getState().sendSymbol(windowId("scanner-c"), windowId("chart-a1"), { code: "000660", name: "SK하이닉스" });
    expect(res.changed).toEqual([windowId("book-c1"), windowId("brokers-c1")]);
    const state = useLayoutStore.getState();
    expect(linkedWindowSymbol(state.layout, windowId("book-c1"), windowId("chart-a1"), state.groupSymbols)).toBe("000660");
    expect(linkedWindowSymbol(state.layout, windowId("brokers-c1"), windowId("chart-a1"), state.groupSymbols)).toBe("000660");
  });

  it("protects manually locked charts from group changes and drops, and rejoins on unlock", () => {
    useLayoutStore.getState().toggleWindowLock(windowId("chart-a2"), windowId("chart-a1"));
    useLayoutStore.getState().sendSymbolToLink("a", windowId("chart-a1"), { code: "000660", name: "SK하이닉스" });
    const afterGroup = useLayoutStore.getState().layout.windows;
    const c1 = afterGroup.find((w) => w.id === windowId("chart-a1"));
    const c2 = afterGroup.find((w) => w.id === windowId("chart-a2"));
    expect(c1 && c1.kind === "chart" ? c1.symbol : null).toBe("000660");
    expect(c2 && c2.kind === "chart" ? c2.symbol : null).toBe("005930");

    const dropRes = useLayoutStore.getState().dropSymbolOnWindow(windowId("chart-a2"), { code: "035420", name: "NAVER" });
    expect(dropRes.changed).toEqual([]);
    expect(dropRes.notice).toContain("고정");

    useLayoutStore.getState().toggleWindowLock(windowId("chart-a2"), windowId("chart-a1"));
    const afterUnlock = useLayoutStore.getState().layout.windows.find((w) => w.id === windowId("chart-a2"));
    expect(afterUnlock && afterUnlock.kind === "chart" ? afterUnlock.symbol : null).toBe("000660");
  });
});
