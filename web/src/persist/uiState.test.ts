import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS, parseUiState, toUiState } from "./uiState";

afterEach(() => vi.restoreAllMocks());

test("옛 라이트 설정은 다크로 옮기고 다른 설정과 모르는 키는 보존한다", () => {
  const raw = {
    rightPanel: "watch",
    rightPanelWidth: "normal",
    lastLayoutId: "L1",
    theme: "light",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
    pinnedMinutes: [],
    phone: { symbol: "000660" },
  };
  const { prefs, extra } = parseUiState(raw);
  expect(prefs).toEqual({
    rightPanel: "watch",
    rightPanelWidth: "normal",
    lastLayoutId: "L1",
    theme: "dark",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
    pinnedMinutes: [],
  });
  expect(extra).toEqual({ phone: { symbol: "000660" } });
  expect(toUiState(prefs, extra)).toEqual({ ...raw, theme: "dark" });
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

test("고정 분봉은 중복과 잘못된 주기를 빼고 저장·복원한다", () => {
  const { prefs, extra } = parseUiState({ lastLayoutId: null, theme: "dark", pinnedMinutes: ["5m", "60m", "D", "5m", "bad", 3], future: true });
  expect(prefs.pinnedMinutes).toEqual(["5m", "60m"]);
  expect(parseUiState(toUiState(prefs, extra))).toEqual({ prefs, extra });
});

test("오른쪽 탭과 너비를 왕복하고 잘못된 값은 기본으로 연다", () => {
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, rightPanel: "screener", rightPanelWidth: "wide", watchCollapsed: true });
  expect(parseUiState(toUiState(prefs, extra)).prefs).toMatchObject({ rightPanel: "screener", rightPanelWidth: "wide", watchCollapsed: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState({ ...DEFAULT_UI_PREFS, rightPanel: "bad", rightPanelWidth: 800 }).prefs).toEqual(DEFAULT_UI_PREFS);
});
