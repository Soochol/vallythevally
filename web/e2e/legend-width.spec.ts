import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BarsPage } from "../src/api/generated/BarsPage";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { openChartSettings } from "./chart-settings-menu";
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

const GUARD_DAY = 86_400;

function makeWidthBars(count: number, endT: number, baseClose: number, stepClose: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = baseClose + i * stepClose;
    return { t: endT - (count - 1 - i) * GUARD_DAY, o: close - 200, h: close + 300, l: close - 300, c: close, v: 1_000 + i * 10 };
  });
}

function seedWidthLayout(scenario: Scenario, settings: Partial<ChartSettings>) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({
    ...layout,
    windows: [{
      id: "cell-0",
      kind: "chart",
      link: null,
      symbol: "005930",
      venue: "combined",
      period: "D",
      chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 40, indicators: AVERAGES, panels: [], compare: ["000660"], showOhlcChange: true, ...settings },
    }],
    placement: {},
  });
}

async function readLegendGeometry(page: Page) {
  return page.evaluate(() => {
    const projection = window.legendSources.projections.at(-1);
    if (!projection) throw new Error("범례 투영이 없습니다");
    const paneHeight = window.chartProbe.chart.panes()[0]?.getHeight() ?? 0;
    const topMargin = window.chartProbe.chart.priceScale("right").options().scaleMargins.top;
    return {
      projections: window.legendSources.projections.length,
      fields: Object.fromEntries(projection.fields.map((field) => [field.key, field.width])),
      topMargin,
      topMarginPx: topMargin * paneHeight,
    };
  });
}

test("체결로 자릿수가 늘었다 준 뒤 투영 필드 폭과 가격 패널 위 여백이 새로 고친 화면과 1px 안에서 같다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page);
  seedWidthLayout(scenario, {});
  const mainBars = makeWidthBars(120, NOV9, 70_000, 40);
  const compareBars = makeWidthBars(120, NOV9, 180_000, 80);
  const finalMain: Bar = { t: NOV9, o: 74_620, h: 75_020, l: 74_520, c: 74_805, v: 1_520 };
  const finalCompare: Bar = { t: NOV9, o: 189_100, h: 189_700, l: 188_900, c: 189_400, v: 1_450 };
  const pages: Record<string, BarsPage> = {
    "005930": { symbol: "005930", venue: "combined", period: "D", bars: mainBars.slice(0, -1), current: mainBars.at(-1)!, nextBefore: null, seq: null },
    "000660": { symbol: "000660", venue: "combined", period: "D", bars: compareBars.slice(0, -1), current: compareBars.at(-1)!, nextBefore: null, seq: null },
  };
  scenario.on(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "D" && !url.searchParams.has("before"),
    (req) => ({ body: pages[new URL(req.url()).searchParams.get("symbol") ?? ""]! }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "120");
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930")).toBe(true);
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "000660")).toBe(true);
  for (const { id } of AVERAGES) await expect(cell(page).locator(`[data-indicator-row="${id}"] > span.font-medium`)).not.toBeEmpty();
  await expect(cell(page).locator('[data-compare-row="000660"]')).not.toHaveAttribute("data-last-t", "");
  await frames(page, 20);

  scenario.live.bar("005930", { t: NOV9, o: 74_600, h: 75_000, l: 74_500, c: 74_800, v: 1_500 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "74800");
  await frames(page, 20);
  const settled = await readLegendGeometry(page);

  scenario.live.bar("005930", { t: NOV9, o: 74_650, h: 75_050, l: 74_550, c: 74_810, v: 1_550 });
  scenario.live.bar("000660", { t: NOV9, o: 189_000, h: 189_800, l: 188_800, c: 189_600, v: 1_500 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "74810");
  await expect(cell(page).locator('[data-compare-row="000660"]')).toHaveAttribute("data-last-close", "189600");
  await frames(page, 12);
  expect((await readLegendGeometry(page)).projections).toBe(settled.projections);

  scenario.live.bar("005930", { t: NOV9, o: 1_200_000, h: 1_250_000, l: 1_190_000, c: 1_234_567, v: 25_000_000 });
  scenario.live.bar("000660", { t: NOV9, o: 999_999, h: 999_999, l: 999_999, c: 999_999, v: 5_000 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "1234567");
  await expect(cell(page).locator('[data-compare-row="000660"]')).toHaveAttribute("data-last-close", "999999");
  await frames(page, 16);
  const grown = await readLegendGeometry(page);
  expect(grown.projections).toBeGreaterThan(settled.projections);
  expect(grown.fields["price/0"]).toBeGreaterThan(settled.fields["price/0"] ?? 0);
  expect(grown.fields["compare/000660"]).toBeGreaterThan(settled.fields["compare/000660"] ?? 0);

  scenario.live.bar("005930", finalMain);
  scenario.live.bar("000660", finalCompare);
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(finalMain.c));
  await expect(cell(page).locator('[data-compare-row="000660"]')).toHaveAttribute("data-last-close", String(finalCompare.c));
  await frames(page, 16);
  const shrunk = await readLegendGeometry(page);
  expect(shrunk.projections).toBeGreaterThan(grown.projections);
  expect(shrunk.fields["price/0"]).toBeLessThan(grown.fields["price/0"] ?? 0);
  expect(shrunk.fields["compare/000660"]).toBeLessThan(grown.fields["compare/000660"] ?? 0);

  pages["005930"] = { symbol: "005930", venue: "combined", period: "D", bars: [...mainBars.slice(0, -1), finalMain], current: null, nextBefore: null, seq: null };
  pages["000660"] = { symbol: "000660", venue: "combined", period: "D", bars: [...compareBars.slice(0, -1), finalCompare], current: null, nextBefore: null, seq: null };
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "120");
  for (const { id } of AVERAGES) await expect(cell(page).locator(`[data-indicator-row="${id}"] > span.font-medium`)).not.toBeEmpty();
  await expect(cell(page).locator('[data-compare-row="000660"]')).not.toHaveAttribute("data-last-t", "");
  await frames(page, 20);
  const fresh = await readLegendGeometry(page);

  expect(Object.keys(shrunk.fields).sort()).toEqual(Object.keys(fresh.fields).sort());
  for (const [key, freshWidth] of Object.entries(fresh.fields)) {
    expect(Math.abs((shrunk.fields[key] ?? 0) - freshWidth), `${key} 폭 차이`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(shrunk.topMarginPx - fresh.topMarginPx)).toBeLessThanOrEqual(1);
});

test("조회 값 제거, 과거 봉 추가, 비교 왼쪽 끝 이동, 멈춤, 표시 설정과 주기 바뀜에서는 범례 폭을 다시 잰다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page);
  seedWidthLayout(scenario, { showOhlcChange: false });
  const allMain = makeWidthBars(150, NOV9, 70_000, 40);
  const olderMain = allMain.slice(0, 40);
  const recentMain = allMain.slice(40);
  const allCompare = makeWidthBars(150, NOV9, 180_000, 80);
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D" && !url.searchParams.has("before"),
    { body: { symbol: "005930", venue: "combined", period: "D", bars: recentMain.slice(0, -1), current: recentMain.at(-1)!, nextBefore: recentMain[0]!.t, seq: null } satisfies BarsPage },
  );
  const olderRequest = scenario.hold(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D" && url.searchParams.has("before"),
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "000660" && url.searchParams.get("period") === "D" && !url.searchParams.has("before"),
    { body: { symbol: "000660", venue: "combined", period: "D", bars: allCompare.slice(0, -1), current: allCompare.at(-1)!, nextBefore: null, seq: null } satisfies BarsPage },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "110");
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930")).toBe(true);
  for (const { id } of AVERAGES) await expect(cell(page).locator(`[data-indicator-row="${id}"] > span.font-medium`)).not.toBeEmpty();
  await expect(cell(page).locator('[data-compare-row="000660"]')).not.toHaveAttribute("data-last-t", "");
  await frames(page, 16);

  const count = () => page.evaluate(() => window.legendSources.projections.length);

  const beforeFetchedClear = await count();
  scenario.live.bar("005930", { t: NOV9, o: 71_000, h: 71_400, l: 70_900, c: 71_100, v: 1_100 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "71100");
  await frames(page, 12);
  const afterFetchedClear = await count();
  expect(afterFetchedClear).toBeGreaterThan(beforeFetchedClear);

  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) throw new Error("차트 범위가 없습니다");
    scale.setVisibleLogicalRange({ from: range.from - 3, to: range.to - 3 });
  });
  await frames(page, 12);
  const afterLeftShift = await count();
  expect(afterLeftShift).toBeGreaterThan(afterFetchedClear);

  await page.evaluate(() => {
    window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 2, to: 41 });
  });
  await olderRequest.received;
  olderRequest.reply({ body: { symbol: "005930", venue: "combined", period: "D", bars: olderMain, current: null, nextBefore: null, seq: null } satisfies BarsPage });
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "150");
  await frames(page, 12);
  const afterPrepend = await count();
  expect(afterPrepend).toBeGreaterThan(afterLeftShift);

  scenario.live.status({ realtime: "reconnecting", since: scenario.now / 1000, backfilling: false });
  await expect(cell(page).locator("[data-price-row]")).toContainText(/멈춤 \d{2}:\d{2}/);
  await frames(page, 12);
  const afterStall = await count();
  expect(afterStall).toBeGreaterThan(afterPrepend);

  const settingsDialog = await openChartSettings(page, "봉 · 선");
  await settingsDialog.getByRole("switch", { name: "봉 값 등락률" }).click();
  await frames(page, 12);
  const afterDisplay = await count();
  expect(afterDisplay).toBeGreaterThan(afterStall);

  await settingsDialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "주", exact: true }).click();
  await expect(cell(page).locator("[data-legend-period]")).toHaveText("주");
  await frames(page, 16);
  expect(await count()).toBeGreaterThan(afterDisplay);
});
