import type { Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { cell, chartOf, expect, pollSaved, type Scenario, test } from "./harness";
import { installLegendSourceProbe } from "./legend-source-probe";

test.use({ clockStart: "20261109100000" });

const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const AVERAGES: ChartSettings["indicators"] = [
  { id: "ma5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
  { id: "ma20", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } },
];

async function frames(page: Page, count: number) {
  await page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

function seed(scenario: Scenario, count: number): number {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, windows: [{ id: "cell-0", kind: "chart", link: null, symbol: "005930", venue: "combined", period: "D", chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 40, indicators: AVERAGES, panels: [], compare: [], showOhlcChange: true } }], placement: {} });
  const source = scenario.market.page({ symbol: "005930", venue: "combined", period: "D", limit: 3000 });
  const all = [...source.bars, ...(source.current ? [source.current] : [])];
  const first = all[0];
  if (!first) throw new Error("원천 봉이 없습니다");
  const extended = [...Array.from({ length: Math.max(0, count - all.length) }, (_, i) => ({ ...first, t: first.t - (count - all.length - i) * 86400 })), ...all].slice(-count);
  const initial: BarsPage = { ...source, bars: extended.slice(0, -1), current: extended.at(-1) ?? null, nextBefore: null };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D", { body: initial });
  const previous = extended.at(-2);
  if (!previous) throw new Error("직전 봉이 없습니다");
  return previous.c;
}

async function tick(page: Page, scenario: Scenario, close: number) {
  scenario.live.bar("005930", { t: NOV9, o: close, h: close, l: close, c: close, v: 1000 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(close));
  await frames(page, 6);
}

async function open(page: Page, scenario: Scenario, count: number): Promise<number> {
  await page.addInitScript(() => {
    const counter = window as unknown as { numberFormats: number };
    counter.numberFormats = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, "format");
    const get = descriptor?.get;
    if (!descriptor || !get) throw new Error("숫자 서식 접근자가 없습니다");
    Object.defineProperty(Intl.NumberFormat.prototype, "format", { ...descriptor, get() { counter.numberFormats++; return get.call(this); } });
  });
  await installLegendSourceProbe(page);
  const previous = seed(scenario, count);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(count));
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930")).toBe(true);
  for (const { id } of AVERAGES) await expect(cell(page).locator(`[data-indicator-row="${id}"] > span.font-medium`)).not.toBeEmpty();
  await tick(page, scenario, previous + 1_100);
  await frames(page, 60);
  return previous;
}

test("같은 자릿수 체결은 범례 폭을 다시 재지 않는다", async ({ page, scenario }) => {
  const previous = await open(page, scenario, 300);
  const before = await page.evaluate(() => window.legendSources.projections.length);
  for (let i = 1; i <= 10; i++) await tick(page, scenario, previous + 1_100 + i * 20);
  expect(await page.evaluate(() => window.legendSources.projections.length)).toBe(before);
  await expect(cell(page).locator("[data-price-row] > span").first()).toHaveText((previous + 1_300).toLocaleString("ko-KR"));
});

test("봉 3000개에서 체결 열 번의 숫자 서식 호출은 만 번을 넘지 않는다", async ({ page, scenario }) => {
  const previous = await open(page, scenario, 3000);
  const before = await page.evaluate(() => (window as unknown as { numberFormats: number }).numberFormats);
  for (let i = 1; i <= 10; i++) await tick(page, scenario, previous + 1_100 + i * 20);
  const formats = await page.evaluate(() => (window as unknown as { numberFormats: number }).numberFormats) - before;
  expect(formats).toBeLessThanOrEqual(10_000);
});
