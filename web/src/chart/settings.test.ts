import { afterEach, expect, test, vi } from "vitest";
import {
  addCompare,
  addIndicator,
  barOpacityOf,
  type ChartSettings,
  type IndicatorConfig,
  clampVisibleBars,
  DEFAULT_CHART_SETTINGS,
  movePanel,
  parseChartSettings,
  readSpecShape,
  compareRefusal,
  removeCompare,
  removeIndicator,
  setIndicatorPlacement,
  setPanelStretches,
  togglePanel,
  shownScale,
  updateIndicator,
} from "./settings";

afterEach(() => vi.restoreAllMocks());

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const rsi: ChartSettings = {
  v: 2,
  style: "line",
  scale: "log",
  indicators: [
    { id: "a", spec: { kind: "ma", method: "ema", period: 5 }, panel: "price", visible: false, style: { colors: ["ind-2"], width: 2 } },
    { id: "b", spec: { kind: "rsi", period: 14, signal: null }, panel: "p1", visible: true, style: { colors: ["ind-3"], width: 1 } },
  ],
  compare: ["005930"],
  panels: [{ id: "p1", stretch: 0.3 }],
  visibleBars: 240,
  showExtremes: true,
  showLegend: false,
  showOhlcChange: true,
  extremeBasis: "extreme",
  showDaySeparators: true,
  showHorzGrid: false,
  showVertGrid: false,
};

test("맞는 v2 모양은 그대로 읽는다", () => {
  expect(parseChartSettings(rsi)).toEqual(rsi);
});

test("보이는 봉 수와 화면 내 최고·최저가 없는 저장값은 자동·끔으로 읽는다", () => {
  const { visibleBars: _bars, showExtremes: _extremes, ...older } = rsi;
  expect(parseChartSettings(older)).toEqual({ ...rsi, visibleBars: null, showExtremes: false });
});

test("범례·봉 값 등락률·최고·최저 등락률 기준이 없는 저장값은 보임·끔·현재가 대비로 읽고 나머지는 그대로 둔다", () => {
  const { showLegend: _legend, showOhlcChange: _change, extremeBasis: _basis, ...older } = rsi;
  expect(parseChartSettings(older)).toEqual({ ...rsi, showLegend: true, showOhlcChange: false, extremeBasis: "last" });
  const v1 = { v: 1, style: "bar", scale: "log", indicators: [], compare: [], panels: [] };
  expect(parseChartSettings(v1)).toMatchObject({ showLegend: true, showOhlcChange: false, extremeBasis: "last" });
  expect(parseChartSettings({ ...v1, showLegend: false, extremeBasis: "extreme" })).toMatchObject({ showLegend: false, showOhlcChange: false, extremeBasis: "extreme" });
});

test("옛 봉 값 줄 켜짐은 값이 무엇이든 버리고 범례를 보임으로 읽는다", () => {
  const { showLegend: _legend, ...current } = rsi;
  for (const showOhlc of [false, true, "false", 0, null]) {
    const read = parseChartSettings({ ...current, showOhlc });
    expect(read).toEqual({ ...rsi, showLegend: true });
    expect(read).not.toHaveProperty("showOhlc");
  }
  const v1 = { v: 1, style: "bar", scale: "log", indicators: [], compare: [], panels: [], showOhlcChange: true, extremeBasis: "extreme" };
  for (const showOhlc of [false, "true"]) {
    const read = parseChartSettings({ ...v1, showOhlc });
    expect(read).toEqual({ ...DEFAULT_CHART_SETTINGS, style: "bar", scale: "log", showOhlcChange: true, extremeBasis: "extreme" });
    expect(read).not.toHaveProperty("showOhlc");
  }
});

test("날짜 구분선 켜짐이 없는 저장값은 끔으로 읽고 나머지는 그대로 둔다", () => {
  const { showDaySeparators: _days, ...older } = rsi;
  expect(parseChartSettings(older)).toEqual({ ...rsi, showDaySeparators: false });
  expect(parseChartSettings({ v: 1, style: "bar", scale: "log", indicators: [], compare: [], panels: [] })).toMatchObject({ showDaySeparators: false });
});

test("가로·세로 격자선 켜짐이 없는 저장값은 켬으로 읽고 나머지는 그대로 둔다", () => {
  const { showHorzGrid: _horz, showVertGrid: _vert, ...older } = rsi;
  expect(parseChartSettings(older)).toEqual({ ...rsi, showHorzGrid: true, showVertGrid: true });
  expect(parseChartSettings({ v: 1, style: "bar", scale: "log", indicators: [], compare: [], panels: [] })).toMatchObject({ showHorzGrid: true, showVertGrid: true });
});

test("자동 봉 수와 경계의 봉 수는 그대로 읽는다", () => {
  expect(parseChartSettings({ ...rsi, visibleBars: null }).visibleBars).toBeNull();
  expect(parseChartSettings({ ...rsi, visibleBars: 10 }).visibleBars).toBe(10);
  expect(parseChartSettings({ ...rsi, visibleBars: 2000 }).visibleBars).toBe(2000);
});

test("직접 넣은 봉 수는 정수로 반올림해 10~2000 안으로 맞추고, 숫자가 아니면 받지 않는다", () => {
  expect(clampVisibleBars(150.4)).toBe(150);
  expect(clampVisibleBars(3)).toBe(10);
  expect(clampVisibleBars(99999)).toBe(2000);
  expect(clampVisibleBars(Number.NaN)).toBeNull();
});

test("v1은 읽을 때 기본 거래량 지표를 넣은 v2로 바꾼다", () => {
  const v1 = { v: 1, style: "bar", scale: "log", indicators: [], compare: ["000660"], panels: [] };
  expect(parseChartSettings(v1)).toEqual({ ...DEFAULT_CHART_SETTINGS, style: "bar", scale: "log", compare: ["000660"] });
});

test("새 차트에는 거래량 지표 하나가 자기 패널에 있다", () => {
  expect(DEFAULT_CHART_SETTINGS.indicators.map((i) => i.spec)).toEqual([{ kind: "volume", maPeriod: null }]);
  expect(DEFAULT_CHART_SETTINGS.panels.map((p) => p.id)).toEqual([DEFAULT_CHART_SETTINGS.indicators[0]!.panel]);
});

test("모르는 키는 버린다", () => {
  const raw = { ...rsi, later: 3, indicators: rsi.indicators.map((i) => ({ ...i, extra: 1, spec: { ...i.spec, extra: 2 } })) };
  expect(parseChartSettings(raw)).toEqual(rsi);
});

test("값의 뜻은 읽을 때 보지 않는다(엔진이 거절하면 설정 오류로 남긴다)", () => {
  const bad = { ...rsi, indicators: [{ ...rsi.indicators[0]!, spec: { kind: "ma", method: "sma", period: 0 } }, rsi.indicators[1]] };
  expect(parseChartSettings(bad).indicators[0]!.spec).toEqual({ kind: "ma", method: "sma", period: 0 });
});

const ind = (over: object) => ({ ...rsi, indicators: [{ ...rsi.indicators[0]!, ...over }, rsi.indicators[1]] });

test.each([
  ["null", null],
  ["문자열", "candle"],
  ["다른 버전", { ...rsi, v: 3 }],
  ["모르는 봉 모양", { ...rsi, style: "heikin" }],
  ["모르는 축", { ...rsi, scale: "pct" }],
  ["비교 종목이 문자열 배열이 아님", { ...rsi, compare: [5930] }],
  ["비교 종목 4개", { ...rsi, compare: ["005930", "000660", "035420", "IDX:001"] }],
  ["같은 비교 종목 둘", { ...rsi, compare: ["000660", "000660"] }],
  ["빠진 키", { v: 2, style: "candle", scale: "normal" }],
  ["봉 수 9", { ...rsi, visibleBars: 9 }],
  ["봉 수 2001", { ...rsi, visibleBars: 2001 }],
  ["소수 봉 수", { ...rsi, visibleBars: 120.5 }],
  ["문자열 봉 수", { ...rsi, visibleBars: "120" }],
  ["켜짐이 문자열", { ...rsi, showExtremes: "true" }],
  ["범례 켜짐이 문자열", { ...rsi, showLegend: "false" }],
  ["범례 켜짐이 null", { ...rsi, showLegend: null }],
  ["봉 값 등락률 켜짐이 숫자", { ...rsi, showOhlcChange: 1 }],
  ["모르는 최고·최저 등락률 기준", { ...rsi, extremeBasis: "high" }],
  ["날짜 구분선 켜짐이 문자열", { ...rsi, showDaySeparators: "true" }],
  ["가로 격자선 켜짐이 문자열", { ...rsi, showHorzGrid: "true" }],
  ["세로 격자선 켜짐이 숫자", { ...rsi, showVertGrid: 0 }],
  ["최고·최저 등락률 기준이 null", { ...rsi, extremeBasis: null }],
  ["v1인데 범례 켜짐이 문자열", { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], showLegend: "true" }],
  ["v1인데 봉 수가 틀림", { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 0 }],
  ["v1인데 지표가 있음", { v: 1, style: "candle", scale: "normal", indicators: [rsi.indicators[0]], compare: [], panels: [] }],
  ["모르는 지표 종류", ind({ spec: { kind: "wma", period: 5 } })],
  ["지표 설정 필드가 빠짐", ind({ spec: { kind: "ma", period: 5 } })],
  ["모르는 색", ind({ style: { colors: ["#fff"], width: 1 } })],
  ["굵기 6", ind({ style: { colors: ["ind-1"], width: 6 } })],
  ["막대 불투명도 0.09", ind({ style: { colors: ["ind-1"], width: 1, barOpacity: 0.09 } })],
  ["막대 불투명도 1.01", ind({ style: { colors: ["ind-1"], width: 1, barOpacity: 1.01 } })],
  ["막대 불투명도가 문자열", ind({ style: { colors: ["ind-1"], width: 1, barOpacity: "0.5" } })],
  ["막대 불투명도가 null", ind({ style: { colors: ["ind-1"], width: 1, barOpacity: null } })],
  ["가격 지표가 지표 패널에", ind({ panel: "p1" })],
  ["지표 패널 지표가 가격 패널에", { ...rsi, indicators: [rsi.indicators[0], { ...rsi.indicators[1]!, panel: "price" }] }],
  ["지표 없는 패널", { ...rsi, panels: [...rsi.panels, { id: "p2", stretch: 1 }] }],
  ["없는 패널을 가리킴", { ...rsi, panels: [{ id: "p9", stretch: 1 }] }],
  ["패널 하나에 지표 둘", { ...rsi, indicators: [...rsi.indicators, { ...rsi.indicators[1]!, id: "c" }], panels: [...rsi.panels, { id: "p2", stretch: 1 }] }],
  ["같은 지표 id 둘", { ...rsi, indicators: [rsi.indicators[0], { ...rsi.indicators[0]!, spec: { kind: "ma", method: "sma", period: 9 } }, rsi.indicators[1]] }],
  ["높이 비율이 문자열", { ...rsi, panels: [{ id: "p1", stretch: "0.3" }] }],
])("모양이 틀리면(%s) 기본 설정으로 열고 콘솔에 남긴다", (_, raw) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseChartSettings(raw)).toEqual(DEFAULT_CHART_SETTINGS);
  expect(warn).toHaveBeenCalledOnce();
});

const volume = (panel: string, style: Partial<IndicatorConfig["style"]> = {}): IndicatorConfig => ({ id: "v", spec: { kind: "volume", maPeriod: 20 }, panel, visible: true, style: { colors: ["ind-1"], width: 1, ...style } });
const withVolume = (panel: string, panels = rsi.panels, style: Partial<IndicatorConfig["style"]> = {}): ChartSettings => ({ ...rsi, indicators: [volume(panel, style), ...rsi.indicators], panels });

test("막대 불투명도가 없는 옛 설정은 다른 값을 그대로 읽고 0.38로 그린다", () => {
  const old = withVolume("p0", [{ id: "p0", stretch: 0.25 }, ...rsi.panels]);
  const read = parseChartSettings(old);
  expect(read).toEqual(old);
  expect(read.indicators[0]!.style).not.toHaveProperty("barOpacity");
  expect(barOpacityOf(read.indicators[0]!.style)).toBe(0.38);
  expect(barOpacityOf(DEFAULT_CHART_SETTINGS.indicators[0]!.style)).toBe(0.38);
});

test.each([0.1, 0.8, 1])("막대 불투명도 %s는 그대로 읽는다", (barOpacity) => {
  const saved = withVolume("p0", [{ id: "p0", stretch: 0.25 }, ...rsi.panels], { barOpacity });
  expect(parseChartSettings(saved)).toEqual(saved);
  expect(barOpacityOf(parseChartSettings(saved).indicators[0]!.style)).toBe(barOpacity);
});

test("가격 패널에 겹친 거래량은 패널 없이 읽는다", () => {
  const over = withVolume("price");
  expect(parseChartSettings(over)).toEqual(over);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseChartSettings({ ...over, panels: [{ id: "p0", stretch: 0.25 }, ...rsi.panels] })).toEqual(DEFAULT_CHART_SETTINGS);
  expect(warn).toHaveBeenCalledOnce();
});

test("거래량을 겹치면 그 패널만 빼고, 되돌리면 맨 앞에 기본 높이 패널을 더한다", () => {
  const separate = withVolume("p0", [{ id: "p0", stretch: 0.4 }, { id: "p1", stretch: 0.3, collapsed: true }]);
  const over = setIndicatorPlacement(separate, "v", "price");
  expect(over.panels).toEqual([{ id: "p1", stretch: 0.3, collapsed: true }]);
  expect(over.indicators.map((i) => [i.id, i.panel])).toEqual([["v", "price"], ["a", "price"], ["b", "p1"]]);
  expect(parseChartSettings(over)).toEqual(over);
  const back = setIndicatorPlacement(over, "v", "panel");
  expect(back.panels.map((p) => p.stretch)).toEqual([0.25, 0.3]);
  expect(back.panels[1]).toEqual({ id: "p1", stretch: 0.3, collapsed: true });
  expect(back.indicators[0]).toMatchObject({ id: "v", panel: back.panels[0]!.id });
  expect(parseChartSettings(back)).toEqual(back);
  expect(setIndicatorPlacement(over, "v", "panel", { id: "p0", stretch: 0.4 }, 1)).toEqual(withVolume("p0", [{ id: "p1", stretch: 0.3, collapsed: true }, { id: "p0", stretch: 0.4 }]));
  expect(setIndicatorPlacement(over, "v", "price")).toBe(over);
  expect(setIndicatorPlacement(separate, "v", "panel")).toBe(separate);
});

test("거래량이 아닌 지표의 자리는 바꾸지 않는다", () => {
  expect(setIndicatorPlacement(rsi, "a", "panel")).toBe(rsi);
  expect(setIndicatorPlacement(rsi, "b", "price")).toBe(rsi);
  expect(setIndicatorPlacement(rsi, "nope", "price")).toBe(rsi);
});

test("거래량은 고른 자리에 더하고, 다른 지표는 고른 자리와 상관없이 제 자리에 더한다", () => {
  const style = { colors: ["ind-1" as const], width: 1 as const, barOpacity: 0.6 };
  const over = addIndicator(rsi, { kind: "volume", maPeriod: null }, style, ids(), "price");
  expect(over.settings.panels).toEqual(rsi.panels);
  expect(over.settings.indicators.at(-1)).toMatchObject({ panel: "price", style });
  expect(parseChartSettings(over.settings)).toEqual(over.settings);
  const separate = addIndicator(rsi, { kind: "volume", maPeriod: null }, style, ids(), "panel");
  expect(separate.settings.panels.at(-1)).toEqual({ id: "id-2", stretch: 0.25 });
  const ma = addIndicator(rsi, { kind: "ma", method: "sma", period: 5 }, style, ids(), "panel");
  expect(ma.settings.panels).toEqual(rsi.panels);
  expect(ma.settings.indicators.at(-1)!.panel).toBe("price");
  const macd = addIndicator(rsi, { kind: "macd", fast: 12, slow: 26, signal: 9 }, style, ids(), "price");
  expect(macd.settings.indicators.at(-1)!.panel).toBe("id-2");
});

test("가격 패널 지표는 패널을 만들지 않고, 지표 패널 지표는 맨 아래에 패널 하나를 붙인다", () => {
  const make = ids();
  const style = { colors: ["ind-1" as const], width: 1 as const };
  const withMa = addIndicator(DEFAULT_CHART_SETTINGS, { kind: "ma", method: "sma", period: 20 }, style, make);
  expect(withMa.settings.panels).toEqual(DEFAULT_CHART_SETTINGS.panels);
  expect(withMa.settings.indicators.at(-1)).toMatchObject({ id: withMa.id, panel: "price", visible: true });
  const withMacd = addIndicator(withMa.settings, { kind: "macd", fast: 12, slow: 26, signal: 9 }, style, make);
  expect(withMacd.settings.indicators.at(-1)!.panel).toBe(withMacd.settings.panels.at(-1)!.id);
  expect(parseChartSettings(withMacd.settings)).toEqual(withMacd.settings);
});

test("지표 패널 지표를 지우면 그 패널도 지운다", () => {
  const next = removeIndicator(rsi, "b");
  expect(next.panels).toEqual([]);
  expect(next.indicators.map((i) => i.id)).toEqual(["a"]);
  expect(parseChartSettings(next)).toEqual(next);
  expect(removeIndicator(rsi, "nope")).toBe(rsi);
});

test("편집은 같은 종류 안에서만 하고, 바뀐 것이 없으면 같은 객체를 돌려준다", () => {
  expect(updateIndicator(rsi, "b", { spec: { kind: "rsi", period: 9, signal: 3 } }).indicators[1]!.spec).toEqual({ kind: "rsi", period: 9, signal: 3 });
  expect(updateIndicator(rsi, "b", { spec: { kind: "macd", fast: 1, slow: 2, signal: 3 } })).toBe(rsi);
  expect(updateIndicator(rsi, "a", { visible: true }).indicators[0]!.visible).toBe(true);
});

test("패널 순서와 높이 비율", () => {
  const two: ChartSettings = {
    ...rsi,
    indicators: [...rsi.indicators, { ...rsi.indicators[1]!, id: "c", panel: "p2" }],
    panels: [...rsi.panels, { id: "p2", stretch: 0.5 }],
  };
  expect(movePanel(two, "p2", -1).panels.map((p) => p.id)).toEqual(["p2", "p1"]);
  expect(movePanel(two, "p2", 1)).toBe(two);
  expect(setPanelStretches(two, [0.4, 0.6]).panels.map((p) => p.stretch)).toEqual([0.4, 0.6]);
  expect(setPanelStretches(two, [0.3, 0.5])).toBe(two);
  expect(setPanelStretches(two, [0.3])).toBe(two);
});

test("% 축은 저장할 수 있고, v2 그대로 읽는다", () => {
  const pct = { ...rsi, scale: "percent" };
  expect(parseChartSettings(pct)).toEqual(pct);
});

test("비교 종목이 있으면 저장된 축과 상관없이 %로 그리고, 모두 지우면 저장된 축으로 돌아간다", () => {
  expect(shownScale({ scale: "log", compare: ["000660"] })).toBe("percent");
  expect(shownScale({ scale: "log", compare: [] })).toBe("log");
  expect(shownScale({ scale: "percent", compare: [] })).toBe("percent");
  expect(removeCompare({ ...rsi, compare: ["000660"] }, "000660")).toMatchObject({ scale: "log", compare: [] });
});

test("비교 종목은 3개까지, 서로 다르게, 주 종목이 아닌 것만 더한다", () => {
  const one = addCompare({ ...rsi, compare: [] }, "000660", "005930");
  expect(one.compare).toEqual(["000660"]);
  const three = addCompare(addCompare(one, "035420", "005930"), "IDX:001", "005930");
  expect(three.compare).toEqual(["000660", "035420", "IDX:001"]);
  expect(parseChartSettings(three)).toEqual(three);
  expect(compareRefusal(three, "051910", "005930")).toBe("full");
  expect(addCompare(three, "051910", "005930")).toBe(three);
  expect(compareRefusal(one, "000660", "005930")).toBe("dup");
  expect(addCompare(one, "000660", "005930")).toBe(one);
  expect(compareRefusal(one, "005930", "005930")).toBe("main");
  expect(compareRefusal(one, "035420", "005930")).toBeNull();
});

test("비교 종목을 빼면 나머지 순서를 지키고, 없는 종목이면 같은 객체를 돌려준다", () => {
  const s = { ...rsi, compare: ["000660", "035420", "IDX:001"] };
  expect(removeCompare(s, "035420").compare).toEqual(["000660", "IDX:001"]);
  expect(removeCompare(s, "051910")).toBe(s);
});

test("사용자 지정 선 색과 굵기 5는 저장한 차트 설정에서 손실 없이 복원한다", () => {
  const raw = { ...DEFAULT_CHART_SETTINGS, panels: [], indicators: [{ id: "custom", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["#8B5CF6"], width: 5 } }] };
  expect(parseChartSettings(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
});

test("패널 접힘은 저장한 높이와 지표 표시를 보존하고 과거 설정도 읽는다", () => {
  const original = { ...DEFAULT_CHART_SETTINGS, panels: [{ ...DEFAULT_CHART_SETTINGS.panels[0]!, stretch: 0.4 }] };
  const panel = original.panels[0]!;
  const collapsed = togglePanel(original, panel.id);
  expect(collapsed.panels[0]).toEqual({ ...panel, collapsed: true });
  expect(collapsed.indicators).toBe(original.indicators);
  expect(parseChartSettings(JSON.parse(JSON.stringify(collapsed)))).toEqual(collapsed);
  expect(togglePanel(collapsed, panel.id).panels[0]).toEqual({ ...panel, collapsed: false });
  expect(parseChartSettings(original)).toEqual(original);
});

test("음수·0 패널 높이를 읽으면 해당 높이만 기본 비율로 복구한다", () => {
  for (const stretch of [-0.1, 0]) {
    const original = { ...rsi, panels: rsi.panels.map((panel, i) => i === 0 ? { ...panel, stretch, collapsed: true } : panel) };
    const restored = parseChartSettings(original);
    expect(restored).toEqual({ ...original, panels: original.panels.map((panel, i) => i === 0 ? { ...panel, stretch: 0.25 } : panel) });
    expect(restored.indicators).toEqual(rsi.indicators);
  }
});

test("작은 양수 패널 비율도 저장 과정에서 0으로 반올림하지 않는다", () => {
  const settings = setPanelStretches(DEFAULT_CHART_SETTINGS, [0.0001]);
  expect(settings.panels[0]?.stretch).toBe(0.0001);
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
});

test("총잔량 설정을 저장했다가 그대로 읽는다", () => {
  const settings: ChartSettings = {
    ...DEFAULT_CHART_SETTINGS,
    indicators: [{ id: "totals", spec: { kind: "quoteTotals" }, panel: "quotes", visible: true, style: { colors: ["ind-1"], width: 1 } }],
    panels: [{ id: "quotes", stretch: 0.25 }],
  };
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
});

test("히트맵 설정을 저장했다가 그대로 읽고 틀린 값은 거절한다", () => {
  const spec = { kind: "quoteDepth", source: "peak", topLevels: 3, maxOpacity: 0.45, aboveBars: true, askColor: "#4FC7B8", bidColor: null };
  const raw = { ...DEFAULT_CHART_SETTINGS, indicators: [{ id: "heat", spec, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }], panels: [] };
  expect(parseChartSettings(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
  expect(readSpecShape(spec)).toEqual(spec);
  expect(readSpecShape({ ...spec, topLevels: null })).toEqual({ ...spec, topLevels: null });
  const wrong: Record<string, unknown>[] = [
    { source: "mean" }, { topLevels: 0 }, { topLevels: 6 }, { topLevels: 1.5 }, { maxOpacity: 0.19 }, { maxOpacity: 1.01 }, { maxOpacity: "0.5" },
    { aboveBars: "true" }, { askColor: "red" }, { bidColor: "ind-1" }, { bidColor: undefined },
  ];
  for (const patch of wrong) expect(readSpecShape({ ...spec, ...patch }), JSON.stringify(patch)).toBeNull();
  const withMicro = { ...spec, showSpoof: true, showIceberg: true, microLabelMode: "verbose" as const };
  expect(readSpecShape(withMicro)).toEqual(withMicro);
  expect(readSpecShape({ ...spec, showSpoof: "true" })).toBeNull();
  expect(readSpecShape({ ...spec, showIceberg: 1 })).toBeNull();
  expect(readSpecShape({ ...spec, microLabelMode: "full" })).toBeNull();
});

test("계층별 CVD와 프로그램 수급 설정을 저장했다가 읽고 잘못된 값은 거절한다", () => {
  const cvd = { kind: "tickCvd", showWhale: true, showLarge: true, showMid: false, showRetail: true } as const;
  const prog = { kind: "programFlow", showShare: true } as const;
  const settings: ChartSettings = {
    ...DEFAULT_CHART_SETTINGS,
    indicators: [
      { id: "cvd", spec: cvd, panel: "p-cvd", visible: true, style: { colors: ["ind-1", "ind-2", "ind-3"], width: 1 } },
      { id: "prog", spec: prog, panel: "p-prog", visible: true, style: { colors: ["ind-4", "ind-5"], width: 2 } },
    ],
    panels: [{ id: "p-cvd", stretch: 0.25 }, { id: "p-prog", stretch: 0.25 }],
  };
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  expect(readSpecShape({ ...cvd, showWhale: "yes" })).toBeNull();
  expect(readSpecShape({ ...prog, showShare: 1 })).toBeNull();
});
