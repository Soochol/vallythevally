import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS, parseChartSettings } from "./settings";

afterEach(() => vi.restoreAllMocks());

test("맞는 모양은 그대로 읽는다", () => {
  const raw = { v: 1, style: "line", scale: "log", indicators: [], compare: ["005930"], panels: [] };
  expect(parseChartSettings(raw)).toEqual(raw);
});

test("모르는 키는 버린다", () => {
  const raw = { v: 1, style: "bar", scale: "normal", indicators: [], compare: [], panels: [], later: 3 };
  expect(parseChartSettings(raw)).toEqual({ ...DEFAULT_CHART_SETTINGS, style: "bar" });
});

test.each([
  ["null", null],
  ["문자열", "candle"],
  ["다른 버전", { ...DEFAULT_CHART_SETTINGS, v: 2 }],
  ["모르는 봉 모양", { ...DEFAULT_CHART_SETTINGS, style: "heikin" }],
  ["모르는 축", { ...DEFAULT_CHART_SETTINGS, scale: "percent" }],
  ["비교 종목이 문자열 배열이 아님", { ...DEFAULT_CHART_SETTINGS, compare: [5930] }],
  ["빠진 키", { v: 1, style: "candle", scale: "normal" }],
])("모양이 틀리면(%s) 기본 설정으로 열고 콘솔에 남긴다", (_, raw) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseChartSettings(raw)).toEqual(DEFAULT_CHART_SETTINGS);
  expect(warn).toHaveBeenCalledOnce();
});
