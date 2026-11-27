import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { windowId } from "../layout/kinds";
import { DEFAULT_LAYOUT, linkedWindowSymbol, useLayoutStore, watchedSymbol, type EditableLayout } from "../stores/layout";
import { usePersistStore } from "../stores/persist";
import { clearGroupSymbols, groupSymbolsKey, readGroupSymbols, writeGroupSymbols } from "./groupSymbols";

const memory = new Map<string, string>();
const state = () => useLayoutStore.getState();

function layoutWith(id: string, windows: EditableLayout["windows"]): EditableLayout {
  return { ...structuredClone(DEFAULT_LAYOUT), id, windows };
}

function chartlessLayout(id = DEFAULT_LAYOUT.id): EditableLayout {
  return layoutWith(id, [
    { id: windowId("cell-0"), link: "a", kind: "chart", symbol: "005930", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
    { id: windowId("program"), link: "c", kind: "program" },
    { id: windowId("book"), link: "d", kind: "book" },
    { id: windowId("watchlist"), link: "e", kind: "watchlist" },
    { id: windowId("screener"), link: "c", kind: "screener" },
  ]);
}

beforeEach(() => {
  memory.clear();
  usePersistStore.getState().setPhase({ kind: "restoring" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  });
  state().load(structuredClone(DEFAULT_LAYOUT));
});

afterEach(() => {
  usePersistStore.getState().setPhase({ kind: "restoring" });
  vi.unstubAllGlobals();
});

test("차트 없는 연동 색의 종목만 저장·복원하고 차트·발신 전용·고아 색은 걸러낸다", () => {
  const layout = chartlessLayout();
  writeGroupSymbols(layout, { a: "000660", c: "035420", d: "IDX:001", e: "005380", f: "051910" });
  expect(JSON.parse(memory.get(groupSymbolsKey(layout.id))!)).toEqual({ v: 1, symbols: { c: "035420", d: "IDX:001" } });
  expect(readGroupSymbols(layout)).toEqual({ c: "035420", d: "IDX:001" });

  memory.set(groupSymbolsKey(layout.id), JSON.stringify({ v: 1, symbols: { a: "000660", c: "035420", e: "005380", f: "051910", z: "005930" } }));
  expect(readGroupSymbols(layout)).toEqual({ c: "035420" });
});

test("없거나 깨진 저장값과 형식에 맞지 않는 종목코드는 무시한다", () => {
  const layout = chartlessLayout();
  const key = groupSymbolsKey(layout.id);
  expect(readGroupSymbols(layout)).toEqual({});
  for (const raw of ["{", "null", "[]", '{"v":2,"symbols":{"c":"005930"}}', '{"v":1,"symbols":null}', '{"v":1,"symbols":[]}']) {
    memory.set(key, raw);
    expect(readGroupSymbols(layout)).toEqual({});
  }
  memory.set(key, JSON.stringify({ v: 1, symbols: { c: "bad-code", d: "005930" } }));
  expect(readGroupSymbols(layout)).toEqual({ d: "005930" });
  memory.set(key, JSON.stringify({ v: 1, symbols: { c: "idx:001", d: "IDX:101" } }));
  expect(readGroupSymbols(layout)).toEqual({ d: "IDX:101" });
  memory.set(key, JSON.stringify({ v: 1, symbols: { c: "IDX:BAD", d: "IDX:123456" } }));
  expect(readGroupSymbols(layout)).toEqual({});
});

test("저장소 읽기·쓰기·삭제 오류와 localStorage 부재 시 예외 없이 동작한다", () => {
  const layout = chartlessLayout();
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("read"); },
    setItem: () => { throw new Error("write"); },
    removeItem: () => { throw new Error("remove"); },
  });
  expect(readGroupSymbols(layout)).toEqual({});
  expect(() => writeGroupSymbols(layout, { c: "005930" })).not.toThrow();
  expect(() => writeGroupSymbols(layout, {})).not.toThrow();
  expect(() => clearGroupSymbols(layout.id)).not.toThrow();

  vi.stubGlobal("localStorage", undefined);
  expect(readGroupSymbols(layout)).toEqual({});
  expect(() => writeGroupSymbols(layout, { c: "005930" })).not.toThrow();
  expect(() => clearGroupSymbols(layout.id)).not.toThrow();
});

test("스토어 변경은 차트 없는 연동 종목을 자동 저장·정리하고 닫기 되돌리기와 재로드를 보존한다", () => {
  const initial = chartlessLayout("layout-a");
  memory.set(groupSymbolsKey("layout-a"), JSON.stringify({ v: 1, symbols: { a: "000660", c: "035420" } }));
  state().load(initial);
  expect(state().groupSymbols).toEqual({ a: "005930", c: "035420" });

  state().sendSymbol(windowId("screener"), windowId("cell-0"), { code: "000660" });
  expect(readGroupSymbols(state().layout)).toEqual({ c: "000660" });

  const savedSnapshot = structuredClone(state().layout);
  state().load(savedSnapshot);
  expect(state().groupSymbols).toEqual({ a: "005930", c: "000660" });

  state().closeWindow(windowId("program"));
  expect(memory.has(groupSymbolsKey("layout-a"))).toBe(false);

  state().undoArrangement();
  expect(state().groupSymbols.c).toBe("000660");
  expect(readGroupSymbols(state().layout)).toEqual({ c: "000660" });

  state().setLink(windowId("cell-0"), "c");
  expect(memory.has(groupSymbolsKey("layout-a"))).toBe(false);
  expect(state().groupSymbols.c).toBe("005930");
  expect(watchedSymbol(state().layout, windowId("screener"), windowId("cell-0"), state().groupSymbols)).toBe("005930");
  expect(linkedWindowSymbol(state().layout, windowId("program"), windowId("cell-0"), state().groupSymbols)).toBe("005930");
});

test("오프라인 폴백 상태에서는 레이아웃 편집이 저장된 차트 없는 연동 종목을 지우지 않는다", () => {
  const savedKey = groupSymbolsKey(DEFAULT_LAYOUT.id);
  const stored = JSON.stringify({ v: 1, symbols: { c: "005930" } });
  memory.set(savedKey, stored);
  usePersistStore.getState().setPhase({ kind: "offline", message: "offline" });
  state().setPeriod(windowId("cell-0"), "W");
  expect(memory.get(savedKey)).toBe(stored);
});

test("서로 다른 레이아웃은 각자의 차트 없는 연동 종목만 유지하고 clearGroupSymbols는 대상만 지운다", () => {
  const first = chartlessLayout("layout-1");
  const second = chartlessLayout("layout-2");
  state().load(first);
  state().sendSymbol(windowId("screener"), windowId("cell-0"), { code: "000660" });
  state().load(second);
  expect(state().groupSymbols.c).toBeUndefined();
  state().sendSymbol(windowId("screener"), windowId("cell-0"), { code: "035420" });

  state().load(first);
  expect(state().groupSymbols.c).toBe("000660");
  state().load(second);
  expect(state().groupSymbols.c).toBe("035420");

  clearGroupSymbols("layout-1");
  expect(memory.has(groupSymbolsKey("layout-1"))).toBe(false);
  expect(memory.has(groupSymbolsKey("layout-2"))).toBe(true);
});
