import type { IChartApi } from "lightweight-charts";
import { expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice, formatVolume } from "../../lib/format";
import { trackedValuesOf } from "../legendShapes";
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

const DEPTH: IndicatorConfig = {
  id: "heat",
  spec: { kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null },
  panel: "price",
  visible: true,
  style: { colors: ["ind-1"], width: 1 },
};

test("체결로 범례 폭을 다시 잴 때 히트맵 점을 다시 훑지 않는다", () => {
  const add = () => new StrictSeries();
  const chart = { addSeries: add, addCustomSeries: add, removeSeries: () => {}, panes: () => [] };
  const layer = new IndicatorLayer(
    { chart: chart as unknown as IChartApi, tokens: () => TOKENS, isIndex: () => false, period: () => "1m", requestFrame: () => {}, axisFormatted: () => {}, axisCoordinates: () => [], axisFailed: () => {}, guard: (draw) => draw() },
    () => ({ chart: 1, post: () => {}, close: () => {} }),
  );
  layer.setConfigs([DEPTH], []);
  const bars = Array.from({ length: 300 }, (_, i) => bar(i));
  layer.reset({ bars, current: null, nextBefore: null });

  const points = new Map<UnixSeconds, QuoteDepthPoint>(
    bars.map((b) => [b.t, { t: b.t, asks: [[70_100, 1_000]], bids: [[70_000, 2_000]] }]),
  );
  let atCalls = 0;
  const view: QuoteView<QuoteDepthPoint> = {
    state: "ready",
    at: (t) => {
      atCalls++;
      return points.get(t);
    },
  };
  layer.setQuoteDepths(new Map([["heat", view]]));

  const initial = layer.priceLegendValues();
  expect(initial).toHaveLength(1);
  const askTracked = trackedValuesOf(initial[0]!.slots[0]!)!;
  const bidTracked = trackedValuesOf(initial[0]!.slots[1]!)!;
  expect(askTracked).not.toBeNull();
  expect(initial[0]!.slots[0]).toContain(`${formatPrice(70_100, false)} ${formatVolume(1_000)}`);
  const askVersion = askTracked.shapeVersion;
  const bidVersion = bidTracked.shapeVersion;

  points.set(at(10), { t: at(10), asks: [[71_200, 1_500]], bids: [[70_900, 2_500]] });
  layer.setQuoteDepths(new Map([["heat", view]]));
  layer.priceLegendValues();
  expect(askTracked.shapeVersion).toBe(askVersion);
  expect(bidTracked.shapeVersion).toBe(bidVersion);

  atCalls = 0;
  for (let tick = 0; tick < 5; tick++) {
    const live: Bar = { ...bar(300), c: 100 + tick };
    layer.advance({ bars, current: live, nextBefore: null }, live, "live");
    layer.priceLegendValues();
  }
  expect(atCalls).toBeLessThanOrEqual(5);
  const askAfterTicks = askTracked.shapeVersion;
  const bidAfterTicks = bidTracked.shapeVersion;

  points.set(at(10), { t: at(10), asks: [[999_000, 5_000_000]], bids: [[998_000, 6_000_000]] });
  layer.setQuoteDepths(new Map([["heat", view]]));
  const refreshed = layer.priceLegendValues();
  expect(askTracked.shapeVersion).toBe(askAfterTicks + 1);
  expect(bidTracked.shapeVersion).toBe(bidAfterTicks + 1);
  expect(refreshed[0]!.slots[0]).toContain(`${formatPrice(999_000, false)} ${formatVolume(5_000_000)}`);
  expect(refreshed[0]!.slots[1]).toContain(`${formatPrice(998_000, false)} ${formatVolume(6_000_000)}`);
  layer.dispose();
});
