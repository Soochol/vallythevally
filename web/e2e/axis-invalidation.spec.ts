import type { IPriceScaleApi } from "lightweight-charts";
import { KINDS } from "../src/chart/indicators/kinds";
import type { ChartSettings } from "../src/chart/settings";
import type { Layout } from "../src/api/generated/Layout";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

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

test("같은 가격의 체결·worker 프레임은 거래량 축만 무효화하고 한 축은 프레임당 한 번만 갱신한다", async ({ page, app }) => {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const specs = [KINDS.volume.defaults, KINDS.rsi.defaults, KINDS.macd.defaults, KINDS.stochSlow.defaults];
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: specs.map((spec, i) => ({ id: `i${i}`, spec, panel: `p${i}`, visible: true, style: { colors: ["ind-1", "ind-2", "ind-3"], width: 1 } })), panels: specs.map((_, i) => ({ id: `p${i}`, stretch: 0.3 })) };
  const saved = await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "005930", venue: "combined", period: "D", chartSettings }] }) });
  expect(saved.ok).toBe(true);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toContain("005930_AL");
  await expect.poll(() => page.evaluate(() => window.frameProbe.snapshot().filter((series) => series.data.length > 0).length >= 5)).toBe(true);
  const volume = () => page.evaluate(() => {
    const last = window.frameProbe.snapshot().find((series) => series.type === "Histogram")?.data.at(-1);
    return last && "value" in last ? last.value : null;
  });
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  expect(await app.fake.pushReal("0B", "005930_AL", { "20": "100031", "10": "+195000", "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" })).toBeGreaterThan(0);
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "195000");
  await settle();
  await page.evaluate(installInvalidationProbe);
  for (let i = 0; i < 3; i++) {
    const previous = await volume();
    await page.evaluate(() => window.axisInvalidations.reset());
    expect(await app.fake.pushReal("0B", "005930_AL", { "20": `10003${i + 2}`, "10": "+195000", "15": "+1", "13": String(1001 + i), "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" })).toBeGreaterThan(0);
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
