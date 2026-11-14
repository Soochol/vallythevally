import type { IPriceScaleApi } from "lightweight-charts";
import { KINDS } from "../src/chart/indicators/kinds";
import type { ChartSettings } from "../src/chart/settings";
import type { Layout } from "../src/api/generated/Layout";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, withFirstChart } from "./harness";

declare global {
  interface Window {
    axisInvalidations: { reset(): void; snapshot(): { pane: number; frame: number | null }[] };
  }
}

function installInvalidationProbe() {
  const byOptions = new Map(window.chartProbe.chart.panes().map((pane) => [pane.priceScale("right").options(), pane.paneIndex()]));
  const prototype: IPriceScaleApi = Object.getPrototypeOf(window.chartProbe.chart.priceScale("right"));
  const apply = prototype.applyOptions;
  let calls: { pane: number; frame: number | null }[] = [];
  prototype.applyOptions = function (options) {
    if (Object.keys(options).length === 0) {
      const pane = byOptions.get(this.options());
      if (pane !== undefined) calls.push({ pane, frame: typeof document.timeline.currentTime === "number" ? document.timeline.currentTime : null });
    }
    return apply.call(this, options);
  };
  window.axisInvalidations = { reset: () => { calls = []; }, snapshot: () => calls };
}

test.use({ clockStart: "20261109100030" });

test("같은 가격의 체결·worker 프레임은 거래량 축만 무효화하고 한 축은 프레임당 한 번만 갱신한다", async ({ page, scenario }) => {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const specs = [KINDS.volume.defaults, KINDS.rsi.defaults, KINDS.macd.defaults, KINDS.stochSlow.defaults];
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", visibleBars: null, showExtremes: false, showOhlc: true, showOhlcChange: false, extremeBasis: "last", showDaySeparators: false, compare: [], indicators: specs.map((spec, i) => ({ id: `i${i}`, spec, panel: `p${i}`, visible: true, style: { colors: ["ind-1", "ind-2", "ind-3"], width: 1 } })), panels: specs.map((_, i) => ({ id: `p${i}`, stretch: 0.3 })) };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });

  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => scenario.live.subscriptions().map(value => value.symbol)).toContain("005930");
  await expect.poll(() => page.evaluate(() => window.frameProbe.snapshot().filter((series) => series.data.length > 0).length >= 5)).toBe(true);
  const volume = () => page.evaluate(() => {
    const last = window.frameProbe.snapshot().find((series) => series.type === "Histogram")?.data.at(-1);
    const current = window.frameProbe.snapshot().find((series) => series.type === "Candlestick")?.data.at(-1);
    return last && current && last.time === current.time && "value" in last && typeof last.value === "number" ? last.value : null;
  });
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  await expect(async () => {
    expect(await scenario.live.update("005930", { c: Math.abs(Number("+195000")), v: Math.abs(Number("1000")) })).toBeGreaterThan(0);
    await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "195000", { timeout: 500 });
  }).toPass({ timeout: 15000 });
  await expect.poll(volume).not.toBeNull();
  await settle();
  await page.evaluate(installInvalidationProbe);
  for (let i = 0; i < 3; i++) {
    const previous = await volume();
    await page.evaluate(() => window.axisInvalidations.reset());
    expect(await scenario.live.update("005930", { c: Math.abs(Number("+195000")), v: Math.abs(Number(String(1001 + i))) })).toBeGreaterThan(0);
    await expect.poll(volume).toBe(previous! + 1);
    await settle();
    const calls = await page.evaluate(() => window.axisInvalidations.snapshot());
    expect(calls.filter((call) => call.pane === 0)).toEqual([]);
    expect(calls.filter((call) => call.pane > 1)).toEqual([]);
    expect(calls.some((call) => call.pane === 1)).toBe(true);
    expect(new Set(calls.map((call) => `${call.pane}:${call.frame}`)).size).toBe(calls.length);
    await page.evaluate(() => window.axisInvalidations.reset());
    await settle();
    expect(await page.evaluate(() => window.axisInvalidations.snapshot())).toEqual([]);
  }
});
