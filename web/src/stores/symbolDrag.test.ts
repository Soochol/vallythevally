import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { windowId } from "../layout/kinds";
import { DEFAULT_LAYOUT, useLayoutStore } from "./layout";
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
        { id: windowId("order-b"), link: "b", kind: "order", venue: "krx" },
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

  it("detaches a linked chart to ungrouped and changes only that chart", () => {
    const res = useLayoutStore.getState().dropSymbolOnWindow(windowId("chart-a1"), { code: "000660", name: "SK하이닉스" });
    expect(res.changed).toEqual([windowId("chart-a1")]);
    const windows = useLayoutStore.getState().layout.windows;
    const c1 = windows.find((w) => w.id === windowId("chart-a1"));
    const c2 = windows.find((w) => w.id === windowId("chart-a2"));
    expect(c1 && c1.kind === "chart" ? { symbol: c1.symbol, link: c1.link } : null).toEqual({ symbol: "000660", link: null });
    expect(c2 && c2.kind === "chart" ? { symbol: c2.symbol, link: c2.link } : null).toEqual({ symbol: "005930", link: "a" });
  });

  it("pins symbol on linked and ungrouped pinnable windows while preserving link group", () => {
    useLayoutStore.getState().dropSymbolOnWindow(windowId("order-b"), { code: "000660", name: "SK하이닉스" });
    useLayoutStore.getState().dropSymbolOnWindow(windowId("brokers-none"), { code: "035420", name: "NAVER" });
    const windows = useLayoutStore.getState().layout.windows;
    const order = windows.find((w) => w.id === windowId("order-b"));
    const brokers = windows.find((w) => w.id === windowId("brokers-none"));
    expect(order && order.kind === "order" ? { symbol: order.symbol, link: order.link } : null).toEqual({ symbol: "000660", link: "b" });
    expect(brokers && brokers.kind === "brokers" ? { symbol: brokers.symbol, link: brokers.link } : null).toEqual({ symbol: "035420", link: null });
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
});
