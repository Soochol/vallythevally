import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { Period } from "../src/api/generated/Period";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { fromChartTime, toChartTime } from "../src/chart/time";
import { formatPrice } from "../src/lib/format";
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

const AT_1000 = Date.parse("2026-11-09T10:00:00+09:00") / 1000;
const DAY = 86_400;

function makeGuardBars(count: number, endT: number, step: number, baseClose: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = baseClose + i * 1_000;
    return { t: endT - (count - 1 - i) * step, o: close - 200, h: close + 300, l: close - 300, c: close, v: 1_000 + i * 10 };
  });
}

function seedGuardPeriod(scenario: Scenario, period: Period) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({
    ...layout,
    windows: [{
      id: "cell-0",
      kind: "chart",
      link: null,
      symbol: "005930",
      venue: "combined",
      period,
      chartSettings: {
        ...DEFAULT_CHART_SETTINGS,
        visibleBars: 40,
        indicators: [{ id: "ma5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }],
        panels: [],
        compare: [],
      },
    }],
    placement: {},
  });
}

async function openGuard(page: Page, scenario: Scenario, period: Period) {
  await page.addInitScript(installChartProbe);
  seedGuardPeriod(scenario, period);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930" && value.period === period)).toBe(true);
  await expect(cell(page).locator('[data-indicator-row="ma5"] > span.font-medium')).not.toBeEmpty();
  await frames(page, 12);
}

async function guardBarPoint(page: Page, t: number) {
  return page.evaluate((time) => {
    const { chart } = window.chartProbe;
    const box = chart.chartElement().getBoundingClientRect();
    const localX = chart.timeScale().timeToCoordinate(time);
    if (localX === null) throw new Error("가리킬 봉이 없습니다");
    return { x: box.x + localX, y: box.y + (chart.panes()[0]?.getHeight() ?? 600) * 0.6, localX };
  }, toChartTime(t));
}

async function timeAtLocalX(page: Page, localX: number): Promise<number> {
  const chartTime = await page.evaluate((x) => {
    const t = window.chartProbe.chart.timeScale().coordinateToTime(x);
    if (typeof t !== "number") throw new Error("좌표에 봉이 없습니다");
    return t;
  }, localX);
  return fromChartTime(chartTime);
}

test("십자선이 차트를 벗어나면 범례는 마지막 봉 값으로 돌아온다", async ({ page, scenario }) => {
  const bars = makeGuardBars(60, NOV9, DAY, 50_000);
  const body: BarsPage = { symbol: "005930", venue: "combined", period: "D", bars: bars.slice(0, -1), current: bars.at(-1)!, nextBefore: null, seq: 1 };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930", { body });
  await openGuard(page, scenario, "D");
  const closeCell = cell(page).locator("[data-price-row] > span").first();
  const latest = bars.at(-1)!;
  const hovered = bars.at(-10)!;
  await expect(closeCell).toHaveText(formatPrice(latest.c, false));
  const at = await guardBarPoint(page, hovered.t);
  await page.mouse.move(at.x, at.y);
  await expect(closeCell).toHaveText(formatPrice(hovered.c, false));
  await page.mouse.move(0, 0);
  await expect(closeCell).toHaveText(formatPrice(latest.c, false));
});

test("멈춘 마우스 아래로 차트를 스크롤하면 새로 놓인 봉의 값을 범례에 보인다", async ({ page, scenario }) => {
  const bars = makeGuardBars(80, NOV9, DAY, 50_000);
  const body: BarsPage = { symbol: "005930", venue: "combined", period: "D", bars: bars.slice(0, -1), current: bars.at(-1)!, nextBefore: null, seq: 1 };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930", { body });
  await openGuard(page, scenario, "D");
  const closeCell = cell(page).locator("[data-price-row] > span").first();
  const initial = bars.at(-10)!;
  const at = await guardBarPoint(page, initial.t);
  await page.mouse.move(at.x, at.y);
  await expect(closeCell).toHaveText(formatPrice(initial.c, false));
  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) throw new Error("차트 범위가 없습니다");
    scale.setVisibleLogicalRange({ from: range.from - 6, to: range.to - 6 });
  });
  await frames(page, 6);
  const shiftedT = await timeAtLocalX(page, at.localX);
  expect(shiftedT).not.toBe(initial.t);
  const shiftedBar = bars.find((bar) => bar.t === shiftedT);
  if (!shiftedBar) throw new Error("이동된 봉을 찾지 못했습니다");
  await expect(closeCell).toHaveText(formatPrice(shiftedBar.c, false));
});

test("멈춘 마우스 아래에 과거 봉이 추가되면 범례가 새 봉 자리의 값을 보인다", async ({ page, scenario }) => {
  const all = makeGuardBars(100, NOV9, DAY, 50_000);
  const older = all.slice(0, 40);
  const recent = all.slice(40);
  const initialBody: BarsPage = { symbol: "005930", venue: "combined", period: "D", bars: recent.slice(0, -1), current: recent.at(-1)!, nextBefore: recent[0]!.t, seq: 1 };
  const olderBody: BarsPage = { symbol: "005930", venue: "combined", period: "D", bars: older, current: null, nextBefore: null, seq: 1 };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && !url.searchParams.has("before"), { body: initialBody });
  const olderRequest = scenario.hold((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.has("before"));
  await openGuard(page, scenario, "D");
  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    scale.setVisibleLogicalRange({ from: -5, to: 34 });
  });
  await olderRequest.received;
  await frames(page, 2);
  const firstRecent = recent[0]!;
  const at = await guardBarPoint(page, firstRecent.t);
  await page.mouse.move(at.x, at.y);
  const priceRow = cell(page).locator("[data-price-row]");
  await expect(priceRow.locator("> span").first()).toHaveText(formatPrice(firstRecent.c, false));
  await expect(priceRow).not.toContainText("1,000");
  olderRequest.reply({ body: olderBody });
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "100");
  await frames(page, 6);
  const underT = await timeAtLocalX(page, at.localX);
  const underBar = all.find((bar) => bar.t === underT);
  if (!underBar) throw new Error("과거 봉 추가 뒤 봉을 찾지 못했습니다");
  await expect(priceRow.locator("> span").first()).toHaveText(formatPrice(underBar.c, false));
  await expect(priceRow).toContainText("+1,000");
});

test("실시간으로 새 봉이 하나 늘면 멈춘 마우스와 벗어난 마우스의 범례가 각각 맞는 봉을 보인다", async ({ page, scenario }) => {
  const bars = makeGuardBars(60, AT_1000, 60, 100_000);
  const body: BarsPage = { symbol: "005930", venue: "combined", period: "1m", bars: bars.slice(0, -1), current: bars.at(-1)!, nextBefore: null, seq: null };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "1m", { body });
  await openGuard(page, scenario, "1m");
  const closeCell = cell(page).locator("[data-price-row] > span").first();
  const target = bars.at(-10)!;
  const at = await guardBarPoint(page, target.t);
  await page.mouse.move(at.x, at.y);
  await expect(closeCell).toHaveText(formatPrice(target.c, false));
  scenario.live.bar("005930", bars.at(-1)!, "confirmed");
  const added1: Bar = { t: AT_1000 + 60, o: 175_000, h: 176_000, l: 174_000, c: 175_000, v: 2_000 };
  scenario.live.bar("005930", added1);
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "61");
  await frames(page, 6);
  const allAfter1 = [...bars, added1];
  const underT = await timeAtLocalX(page, at.localX);
  const underBar = allAfter1.find((bar) => bar.t === underT);
  if (!underBar) throw new Error("새 봉 추가 뒤 봉을 찾지 못했습니다");
  await expect(closeCell).toHaveText(formatPrice(underBar.c, false));
  await page.mouse.move(0, 0);
  await expect(closeCell).toHaveText(formatPrice(added1.c, false));
  scenario.live.bar("005930", added1, "confirmed");
  const added2: Bar = { t: AT_1000 + 120, o: 188_000, h: 189_000, l: 187_000, c: 188_000, v: 2_500 };
  scenario.live.bar("005930", added2);
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "62");
  await expect(closeCell).toHaveText(formatPrice(added2.c, false));
});
