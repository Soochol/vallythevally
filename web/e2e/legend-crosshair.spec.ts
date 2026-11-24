import type { Page } from "@playwright/test";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, expect, pollSaved, type Scenario, test } from "./harness";
import { installLegendSourceProbe } from "./legend-source-probe";

test.use({ clockStart: "20261109100000" });

const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const COLORS = ["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"] as const;

function movingAverages(count: number): ChartSettings["indicators"] {
  return [5, 10, 20, 60, 120].slice(0, count).map((period, i) => ({ id: `ma${period}`, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: [COLORS[i]!], width: 1 } }));
}

function seed(scenario: Scenario, count: number) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, windows: [{ id: "cell-0", kind: "chart", link: null, symbol: "005930", venue: "combined", period: "D", chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 40, indicators: movingAverages(count), panels: [], compare: [] } }], placement: {} });
}

async function frames(page: Page, count: number) {
  await page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function open(page: Page, scenario: Scenario, count: number) {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page);
  seed(scenario, count);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930")).toBe(true);
  for (const { id } of movingAverages(count)) await expect(cell(page).locator(`[data-indicator-row="${id}"] > span.font-medium`)).not.toBeEmpty();
  await frames(page, 60);
}

async function barPoint(page: Page, t: number) {
  return page.evaluate((time) => {
    const { chart } = window.chartProbe;
    const box = chart.chartElement().getBoundingClientRect();
    const x = chart.timeScale().timeToCoordinate(time);
    if (x === null) throw new Error("가리킬 봉이 없습니다");
    return { x: box.x + x, y: box.y + (chart.panes()[0]?.getHeight() ?? 600) * 0.6 };
  }, toChartTime(t));
}

const paints = (page: Page) => page.evaluate(() => window.legendSources.counts.paint);

test("같은 봉 안에서 움직이면 범례를 고치지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 2);
  const bars = scenario.market.page({ symbol: "005930", venue: "combined", period: "D" }).bars;
  const at = await barPoint(page, bars.at(-10)!.t);
  await page.mouse.move(at.x, at.y);
  await frames(page, 30);
  const close = await cell(page).locator("[data-price-row] > span").first().textContent();
  const before = await paints(page);
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(at.x, at.y + (i % 2 === 0 ? i : -i) * 4);
    await frames(page, 2);
  }
  expect(await paints(page)).toBe(before);
  expect(await cell(page).locator("[data-price-row] > span").first().textContent()).toBe(close);
});

test("멈춘 마우스 아래 체결이 와도 한 프레임에 범례를 두 번 넘게 고치지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 5);
  const at = await barPoint(page, NOV9);
  await page.mouse.move(at.x, at.y);
  await frames(page, 30);
  await page.evaluate(() => {
    const track = window as unknown as { legendFramePeak: number };
    track.legendFramePeak = 0;
    let last = window.legendSources.counts.paint;
    const sample = () => {
      const now = window.legendSources.counts.paint;
      track.legendFramePeak = Math.max(track.legendFramePeak, now - last);
      last = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let i = 1; i <= 10; i++) {
    const close = 200_000 + i * 100;
    scenario.live.bar("005930", { t: NOV9, o: close, h: close, l: close, c: close, v: 1000 + i });
    await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(close));
    await frames(page, 6);
  }
  await expect(cell(page).locator("[data-price-row] > span").first()).toHaveText("201,000");
  expect(await page.evaluate(() => (window as unknown as { legendFramePeak: number }).legendFramePeak)).toBeLessThanOrEqual(2);
});
