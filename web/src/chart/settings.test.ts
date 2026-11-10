import { afterEach, expect, test, vi } from "vitest";
import {
  addIndicator,
  type ChartSettings,
  DEFAULT_CHART_SETTINGS,
  movePanel,
  parseChartSettings,
  removeIndicator,
  setPanelStretches,
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
};

test("맞는 v2 모양은 그대로 읽는다", () => {
  expect(parseChartSettings(rsi)).toEqual(rsi);
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
  ["모르는 축", { ...rsi, scale: "percent" }],
  ["비교 종목이 문자열 배열이 아님", { ...rsi, compare: [5930] }],
  ["빠진 키", { v: 2, style: "candle", scale: "normal" }],
  ["v1인데 지표가 있음", { v: 1, style: "candle", scale: "normal", indicators: [rsi.indicators[0]], compare: [], panels: [] }],
  ["모르는 지표 종류", ind({ spec: { kind: "wma", period: 5 } })],
  ["지표 설정 필드가 빠짐", ind({ spec: { kind: "ma", period: 5 } })],
  ["모르는 색", ind({ style: { colors: ["#fff"], width: 1 } })],
  ["굵기 4", ind({ style: { colors: ["ind-1"], width: 4 } })],
  ["가격 지표가 지표 패널에", ind({ panel: "p1" })],
  ["지표 패널 지표가 가격 패널에", { ...rsi, indicators: [rsi.indicators[0], { ...rsi.indicators[1]!, panel: "price" }] }],
  ["지표 없는 패널", { ...rsi, panels: [...rsi.panels, { id: "p2", stretch: 1 }] }],
  ["없는 패널을 가리킴", { ...rsi, panels: [{ id: "p9", stretch: 1 }] }],
  ["패널 하나에 지표 둘", { ...rsi, indicators: [...rsi.indicators, { ...rsi.indicators[1]!, id: "c" }], panels: [...rsi.panels, { id: "p2", stretch: 1 }] }],
  ["같은 지표 id 둘", { ...rsi, indicators: [rsi.indicators[0], { ...rsi.indicators[0]!, spec: { kind: "ma", method: "sma", period: 9 } }, rsi.indicators[1]] }],
  ["높이 비율 0", { ...rsi, panels: [{ id: "p1", stretch: 0 }] }],
])("모양이 틀리면(%s) 기본 설정으로 열고 콘솔에 남긴다", (_, raw) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseChartSettings(raw)).toEqual(DEFAULT_CHART_SETTINGS);
  expect(warn).toHaveBeenCalledOnce();
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
