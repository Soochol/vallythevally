import { expect, test } from "vitest";
import type { Period } from "../../api/generated/Period";
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type IndicatorConfig, type Panel } from "../settings";
import type { IndicatorSpec } from "./kinds";
import { chartIndicators, chartPanels, financialRequest, type FinancialRequest } from "./shown";

const config = (id: string, spec: IndicatorSpec, panel: IndicatorConfig["panel"], visible = true): IndicatorConfig => ({ id, spec, panel, visible, style: { colors: ["ind-1"], width: 2 } });
const panel = (id: string): Panel => ({ id, stretch: 0.25 });
const settingsOf = (overrides: Partial<ChartSettings> = {}): ChartSettings => ({ ...DEFAULT_CHART_SETTINGS, indicators: [], panels: [], ...overrides });

const ma = config("ma", { kind: "ma", method: "sma", period: 20 }, "price");
const rsi = config("rsi", { kind: "rsi", period: 14, signal: null }, "technical");
const hiddenMacd = config("macd", { kind: "macd", fast: 12, slow: 26, signal: 9 }, "mixed", false);
const revenue = config("revenue", { kind: "revenue" }, "financial");
const hiddenDebt = config("debt", { kind: "debt_ratio" }, "hidden-financial", false);
const dps = config("dps", { kind: "dps" }, "mixed");

const technical = [ma, rsi, hiddenMacd];
const financial = [revenue, hiddenDebt, dps];
const mixed = [revenue, ma, dps, rsi, hiddenDebt, hiddenMacd];
const panels = ["mixed", "financial", "empty", "technical", "hidden-financial"].map(panel);
const nonFinancialPeriods: Period[] = ["1m", "60m", "D", "W", "M"];
const financialPeriods: Period[] = ["Q", "Y"];

test.each([...nonFinancialPeriods, ...financialPeriods])("%s 봉에서 기술지표만 있으면 숨긴 것까지 모두 그린다", (period) => {
  expect(chartIndicators(settingsOf({ indicators: technical }), period)).toEqual(technical);
});

test.each(nonFinancialPeriods)("%s 봉에서는 재무지표를 그리지 않는다", (period) => {
  expect(chartIndicators(settingsOf({ indicators: financial }), period)).toEqual([]);
  expect(chartIndicators(settingsOf({ indicators: mixed }), period)).toEqual([ma, rsi, hiddenMacd]);
});

test.each(financialPeriods)("%s 봉에서는 재무지표를 숨긴 것까지 원래 순서로 그린다", (period) => {
  expect(chartIndicators(settingsOf({ indicators: financial }), period)).toEqual(financial);
  expect(chartIndicators(settingsOf({ indicators: mixed }), period)).toEqual(mixed);
});

test.each<[Period, IndicatorConfig[], string[]]>([
  ["D", mixed, ["mixed", "technical"]],
  ["W", mixed, ["mixed", "technical"]],
  ["M", financial, []],
  ["Q", mixed, ["mixed", "financial", "technical", "hidden-financial"]],
  ["Y", financial, ["mixed", "financial", "hidden-financial"]],
  ["Y", technical, ["mixed", "technical"]],
  ["D", [ma], []],
])("%s 봉의 패널은 그리는 지표가 놓인 것만 원래 순서로 남는다 %#", (period, indicators, ids) => {
  const shown = chartPanels(settingsOf({ indicators, panels }), period);
  expect(shown.map((p) => p.id)).toEqual(ids);
  for (const p of shown) expect(panels).toContain(p);
});

test.each<[string, Period, IndicatorConfig[], FinancialRequest]>([
  ["분기 봉의 보이는 재무지표", "Q", [rsi, revenue], { period: "Q", enabled: true }],
  ["연 봉의 보이는 재무지표", "Y", [revenue], { period: "Y", enabled: true }],
  ["연 봉에서 일부만 숨김", "Y", [hiddenDebt, dps], { period: "Y", enabled: true }],
  ["재무지표가 모두 숨겨짐", "Q", [rsi, hiddenDebt], { period: "Q", enabled: false }],
  ["연 봉의 재무지표가 모두 숨겨짐", "Y", [hiddenDebt], { period: "Y", enabled: false }],
  ["재무지표 없음", "Y", technical, { period: "Y", enabled: false }],
  ["지표 없음", "Q", [], { period: "Q", enabled: false }],
  ["일봉", "D", financial, { period: "Q", enabled: false }],
  ["주봉", "W", financial, { period: "Q", enabled: false }],
  ["월봉", "M", financial, { period: "Q", enabled: false }],
  ["분봉", "5m", financial, { period: "Q", enabled: false }],
])("재무자료 요청: %s", (_, period, indicators, request) => {
  expect(financialRequest(period, settingsOf({ indicators }))).toEqual(request);
});
