import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS, parseUiState, toUiState } from "./uiState";

afterEach(() => vi.restoreAllMocks());

test("옛 라이트 설정은 다크로 옮기고 다른 설정과 모르는 키는 보존한다", () => {
  const raw = {
    rightPanel: "watch",
    panelWidth: 480,
    lastLayoutId: "L1",
    theme: "light",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
    lastMinute: "10m",
    collapsedWatchGroups: ["G1"],
    indicatorWindow: "inspector",
    phone: { symbol: "000660" },
  };
  const { prefs, extra } = parseUiState(raw);
  expect(prefs).toEqual({
    rightPanel: "watch",
    panelWidth: 480,
    lastLayoutId: "L1",
    theme: "dark",
    watchCollapsed: true,
    recentSymbols: ["005930"],
    activeWatchlistId: "W2",
    watchColumns: ["price", "volume"],
    drawing: DEFAULT_UI_PREFS.drawing,
    lastMinute: "10m",
    collapsedWatchGroups: ["G1"],
    indicatorWindow: "inspector",
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

test("마지막 분봉은 왕복하고, 없으면 경고 없이 3분, 분봉이 아니면 3분으로 연다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, lastMinute: "30m" });
  expect(parseUiState(toUiState(prefs, extra)).prefs.lastMinute).toBe("30m");
  const { lastMinute: _minute, ...older } = DEFAULT_UI_PREFS;
  expect(parseUiState(older).prefs.lastMinute).toBe("3m");
  expect(warn).not.toHaveBeenCalled();
  for (const lastMinute of ["D", "M", "bad", 3, null]) expect(parseUiState({ ...DEFAULT_UI_PREFS, lastMinute }).prefs.lastMinute).toBe("3m");
  expect(warn).toHaveBeenCalledTimes(5);
});

test("없어진 고정 분봉은 경고 없이 읽고 버려 다시 저장하지 않는다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { lastMinute: _minute, ...older } = DEFAULT_UI_PREFS;
  const { prefs, extra } = parseUiState({ ...older, pinnedMinutes: ["5m", "60m", "D", "bad", 3], future: true });
  expect(prefs).toEqual(DEFAULT_UI_PREFS);
  expect(extra).toEqual({ future: true });
  expect(toUiState(prefs, extra)).not.toHaveProperty("pinnedMinutes");
  expect(warn).not.toHaveBeenCalled();
});

test("접은 관심종목 그룹은 없으면 빈 목록, 틀리면 기본값이고 중복을 빼고 왕복한다", () => {
  expect(parseUiState({ lastLayoutId: null, theme: "dark" }).prefs.collapsedWatchGroups).toEqual([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState({ lastLayoutId: null, theme: "dark", collapsedWatchGroups: ["G1", 3] }).prefs.collapsedWatchGroups).toEqual([]);
  const { prefs, extra } = parseUiState({ lastLayoutId: null, theme: "dark", collapsedWatchGroups: ["G1", "G2", "G1"] });
  expect(prefs.collapsedWatchGroups).toEqual(["G1", "G2"]);
  expect(parseUiState(toUiState(prefs, extra))).toEqual({ prefs, extra });
});

test("오른쪽 탭을 왕복하고 잘못된 값은 기본으로 연다", () => {
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, rightPanel: "screener", watchCollapsed: true });
  expect(parseUiState(toUiState(prefs, extra)).prefs).toMatchObject({ rightPanel: "screener", watchCollapsed: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseUiState({ ...DEFAULT_UI_PREFS, rightPanel: "bad" }).prefs).toEqual(DEFAULT_UI_PREFS);
});

test("지표 창 방식은 왕복하고, 없으면 경고 없이 가운데 창, 틀리면 가운데 창으로 연다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector" });
  expect(parseUiState(toUiState(prefs, extra)).prefs.indicatorWindow).toBe("inspector");
  const { indicatorWindow: _mode, ...older } = DEFAULT_UI_PREFS;
  expect(parseUiState(older).prefs.indicatorWindow).toBe("dialog");
  expect(warn).not.toHaveBeenCalled();
  expect(parseUiState({ ...DEFAULT_UI_PREFS, indicatorWindow: "side" }).prefs.indicatorWindow).toBe("dialog");
  expect(warn).toHaveBeenCalledOnce();
});

test("사용자가 정한 패널 폭은 왕복하고 숫자가 아니거나 0 이하면 기본 폭으로 연다", () => {
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, panelWidth: 520 });
  expect(parseUiState(toUiState(prefs, extra)).prefs.panelWidth).toBe(520);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const panelWidth of ["wide", 0, -10, Number.NaN]) expect(parseUiState({ ...DEFAULT_UI_PREFS, panelWidth }).prefs.panelWidth).toBeNull();
});

test("없어진 넓게 보기 설정은 읽을 때 버려 다시 저장하지 않는다", () => {
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, rightPanelWidth: "wide" });
  expect(prefs).toEqual(DEFAULT_UI_PREFS);
  expect(toUiState(prefs, extra)).not.toHaveProperty("rightPanelWidth");
});


test("고정 드로잉 도구는 도구 이름만 중복 없이 읽고 새로고침용 UI 상태에 왕복한다", () => {
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, drawing: { pinnedTools: ["hline", "trendline", "hline", "wrong", null], future: 9 } });
  expect(prefs.drawing.pinnedTools).toEqual(["hline", "trendline"]);
  expect(parseUiState(toUiState(prefs, extra)).prefs.drawing).toEqual(prefs.drawing);
  expect(parseUiState({ ...DEFAULT_UI_PREFS, drawing: { pinnedTools: "hline" } }).prefs.drawing.pinnedTools).toEqual([]);
});

test("지표 보기 우측 패널은 차트 옆 방식일 때만 왕복하고 가운데 창 방식이면 관심종목으로 연다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { prefs, extra } = parseUiState({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector", rightPanel: "indicators" });
  expect(parseUiState(toUiState(prefs, extra)).prefs).toMatchObject({ indicatorWindow: "inspector", rightPanel: "indicators" });
  expect(parseUiState({ ...DEFAULT_UI_PREFS, rightPanel: "indicators" }).prefs.rightPanel).toBe("watch");
  expect(parseUiState({ ...DEFAULT_UI_PREFS, indicatorWindow: "side", rightPanel: "indicators" }).prefs).toMatchObject({ indicatorWindow: "dialog", rightPanel: "watch" });
  expect(warn).toHaveBeenCalledOnce();
});
