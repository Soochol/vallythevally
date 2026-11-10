import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS, parseUiState, toUiState } from "./uiState";

afterEach(() => vi.restoreAllMocks());

test("아는 키는 읽고 모르는 키는 extra에 남겨 그대로 돌려보낸다", () => {
  const raw = {
    lastLayoutId: "L1",
    theme: "light",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
    phone: { symbol: "000660" },
  };
  const { prefs, extra } = parseUiState(raw);
  expect(prefs).toEqual({
    lastLayoutId: "L1",
    theme: "light",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
  });
  expect(extra).toEqual({ phone: { symbol: "000660" } });
  expect(toUiState(prefs, extra)).toEqual(raw);
});

test("마이그레이션이 넣은 처음 값(접힘·최근 종목 없음)은 경고 없이 기본값을 채운다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState({ lastLayoutId: "L1", theme: "dark" }).prefs).toEqual({ ...DEFAULT_UI_PREFS, lastLayoutId: "L1" });
  expect(warn).not.toHaveBeenCalled();
});

test("틀린 값은 그 키만 기본값으로 바꾸고 콘솔에 남긴다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { prefs } = parseUiState({ lastLayoutId: 3, theme: "blue", watchCollapsed: "yes", recentSymbols: [1], activeWatchlistId: 1, watchColumns: ["price", "bid"] });
  expect(prefs).toEqual(DEFAULT_UI_PREFS);
  expect(warn).toHaveBeenCalledOnce();
});

test("최근 본 종목은 10개까지만 읽는다", () => {
  const codes = Array.from({ length: 12 }, (_, i) => String(i).padStart(6, "0"));
  expect(parseUiState({ lastLayoutId: null, theme: "dark", recentSymbols: codes }).prefs.recentSymbols).toEqual(codes.slice(0, 10));
});

test("객체가 아니면 기본값으로 연다", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState([1, 2])).toEqual({ prefs: DEFAULT_UI_PREFS, extra: {} });
});

test("고른 열은 정해진 차례로 읽고, 겹치면 틀린 값으로 본다", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState({ lastLayoutId: null, theme: "dark", watchColumns: ["volume", "price"] }).prefs.watchColumns).toEqual(["price", "volume"]);
  expect(parseUiState({ lastLayoutId: null, theme: "dark", watchColumns: [] }).prefs.watchColumns).toEqual([]);
  expect(parseUiState({ lastLayoutId: null, theme: "dark", watchColumns: ["price", "price"] }).prefs.watchColumns).toEqual(DEFAULT_UI_PREFS.watchColumns);
});
