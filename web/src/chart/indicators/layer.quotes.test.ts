import type { IChartApi } from "lightweight-charts";
import { expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { QuoteState, QuoteView } from "../quotes/feed";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import { IndicatorLayer } from "./layer";

interface Datum {
  time: number;
  value?: number;
  base?: number;
  break?: true;
}

class StrictSeries {
  data: Datum[] = [];
  readonly updates: { time: number; value?: number; historical: boolean }[] = [];
  setDataCalls = 0;

  setData(data: Datum[]): void {
    this.data = [...data];
    this.setDataCalls++;
  }

  update(d: Datum, historical = false): void {
    this.updates.push({ time: d.time, value: d.value, historical });
    const last = this.data[this.data.length - 1];
    if (historical) {
      if (!last) throw new Error("Cannot historicalUpdate empty series");
      const idx = this.data.findIndex((known) => known.time === d.time);
      if (idx < 0) throw new Error(`Cannot historicalUpdate unknown time: ${d.time}`);
      this.data[idx] = d;
      return;
    }
    if (last && d.time < last.time) throw new Error(`Cannot update oldest data: ${d.time} < ${last.time}`);
    if (last?.time === d.time) this.data[this.data.length - 1] = d;
    else this.data.push(d);
  }

  applyOptions(): void {}
  priceScale() { return { applyOptions() {} }; }
  createPriceLine() { return { applyOptions() {} }; }
  setSeriesOrder(): void {}
}

const TOKENS = { text2: "text2", line: "line", up: "#FF6B78", down: "#5B9BFF", upVol: "upVol", downVol: "downVol", ind: {} } as unknown as ThemeTokens;
const T0 = Date.parse("2026-11-09T09:00:00+09:00") / 1000;
const at = (minute: number): UnixSeconds => T0 + minute * 60;
const bar = (minute: number): Bar => ({ t: at(minute), o: 100, h: 110, l: 90, c: 100 + minute, v: 1000 });
const TOTALS: IndicatorConfig = { id: "totals", spec: { kind: "quoteTotals" }, panel: "quotes", visible: true, style: { colors: ["ind-1"], width: 1 } };

function totalsView(values: Record<number, [number, number]>, state: QuoteState = "ready"): QuoteView<QuoteTotalPoint> {
  const points = new Map(Object.entries(values).map(([minute, [ask, bid]]) => [at(Number(minute)), { t: at(Number(minute)), ask, bid }]));
  return { state, at: (t) => points.get(t) };
}

test("빈 선과 아직 그리지 않은 점에는 지난 봉 고치기를 쓰지 않는다", () => {
  const series: StrictSeries[] = [];
  const add = () => {
    const s = new StrictSeries();
    series.push(s);
    return s;
  };
  const chart = { addSeries: add, addCustomSeries: add, removeSeries: () => {}, panes: () => [] };
  const layer = new IndicatorLayer(
    { chart: chart as unknown as IChartApi, tokens: () => TOKENS, isIndex: () => false, period: () => "1m", requestFrame: () => {}, axisFormatted: () => {}, axisCoordinates: () => [], axisFailed: () => {}, guard: (draw) => draw() },
    () => ({ chart: 1, post: () => {}, close: () => {} }),
  );
  layer.setConfigs([TOTALS], [{ id: "quotes", stretch: 0.25 }]);
  layer.reset({ bars: [bar(0), bar(1)], current: null, nextBefore: null });
  layer.setQuoteTotals(totalsView({}, "loading"));
  layer.flush();

  const [ask, bid] = series as [StrictSeries, StrictSeries];
  const setsBefore = ask.setDataCalls;
  ask.updates.length = 0;

  layer.setQuoteTotals(totalsView({ 0: [10, 20], 1: [11, 21] }), at(0));
  layer.flush();

  expect(ask.setDataCalls).toBe(setsBefore);
  expect(ask.data).toEqual([
    { time: toChartTime(at(0)), value: 10, base: 10 },
    { time: toChartTime(at(1)), value: 11, base: 11 },
  ]);
  expect(bid.data).toEqual([
    { time: toChartTime(at(0)), value: 20, base: 20 },
    { time: toChartTime(at(1)), value: 21, base: 21 },
  ]);
  expect(ask.updates).toEqual([
    { time: toChartTime(at(0)), value: 10, historical: false },
    { time: toChartTime(at(1)), value: 11, historical: false },
  ]);

  ask.updates.length = 0;
  layer.setQuoteTotals(totalsView({ 0: [15, 25], 1: [16, 26] }), at(0));
  layer.flush();

  expect(ask.setDataCalls).toBe(setsBefore);
  expect(ask.data).toEqual([
    { time: toChartTime(at(0)), value: 15, base: 15 },
    { time: toChartTime(at(1)), value: 16, base: 16 },
  ]);
  expect(ask.updates).toEqual([
    { time: toChartTime(at(0)), value: 15, historical: true },
    { time: toChartTime(at(1)), value: 16, historical: false },
  ]);
  layer.dispose();
});
