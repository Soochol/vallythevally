import type { Locator, Page } from "@playwright/test";
import type { UTCTimestamp } from "lightweight-charts";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutSync } from "../src/api/generated/LayoutSync";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { fromChartTime, toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test, pollSaved } from "./harness";

declare global {
  interface Window { pointedCrosshairTime: UTCTimestamp | null; nativeCrosshairEvents: (UTCTimestamp | null)[] }
}

test.use({ clockStart: "20261109100000" });

const DAY = 86400;
const LAST = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const TARGET = LAST - DAY;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 50 };
const marker = (page: Page, n = 2) => chartOf(cell(page, n)).locator("[data-synced-crosshair]");
const tabs = (page: Page, n: number) => page.getByRole("tablist", { name: `창 묶음 ${n}` });
const bar = (t: number, i: number): Bar => ({ t, o: 50000 + i * 20, h: 50100 + i * 20, l: 49900 + i * 20, c: 50050 + i * 20, v: 1000 + i });
const daily = Array.from({ length: 80 }, (_, i) => bar(LAST - (79 - i) * DAY, i));
const intraday = Array.from({ length: 3 }, (_, day) => Array.from({ length: 12 }, (_, i) => bar(LAST - (2 - day) * DAY + 9 * 3600 + i * 300, day * 12 + i))).flat();

function seed(scenario: Scenario, source: Period, follower: Period, symbol = "005930", tabbed = false) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: source, chartSettings: SETTINGS },
    { id: "cell-1", link: "b", kind: "chart", symbol, venue: "combined", period: follower, chartSettings: SETTINGS },
  ];
  if (tabbed) windows.push(
    { id: "cell-2", link: null, kind: "chart", symbol: "000810", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "watchlist", link: null, kind: "watchlist" },
  );
  const root = {
    kind: "split", dir: "row", ratio: 0.5,
    first: { kind: "group", id: "g1", tabs: tabbed ? ["cell-0", "cell-2"] : ["cell-0"], active: "cell-0" },
    second: { kind: "group", id: "g2", tabs: tabbed ? ["cell-1", "watchlist"] : ["cell-1"], active: "cell-1" },
  };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
}

async function ready(page: Page) {
  await page.goto("/");
  for (const n of [1, 2]) await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbes?.length ?? 0)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function point(page: Page, n: number, time: number) {
  const position = await page.evaluate(({ n, time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    if (!probe) throw new Error("차트 좌표가 없습니다");
    const x = probe.chart.timeScale().timeToCoordinate(time);
    const box = probe.chart.chartElement().getBoundingClientRect();
    if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.62 };
  }, { n, time: toChartTime(time) });
  await page.mouse.move(position.x, position.y);
  await frames(page);
}

async function markerAt(page: Page, n: number, time: number) {
  const shown = marker(page, n);
  await expect(shown).toBeVisible();
  const expected = await page.evaluate(({ n, time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    return probe?.chart.timeScale().timeToCoordinate(time);
  }, { n, time: toChartTime(time) });
  const actual = await shown.locator("div").first().evaluate((line) => Number.parseFloat(line.style.left));
  expect(expected).not.toBeNull();
  expect(Math.abs(actual - Number(expected))).toBeLessThan(1);
  const label = shown.locator("div").last();
  const box = await label.boundingBox();
  const host = await chartOf(cell(page, n)).boundingBox();
  if (!box || !host) throw new Error("시간 꼬리표가 없습니다");
  expect(box.x).toBeGreaterThanOrEqual(host.x);
  expect(box.x + box.width).toBeLessThanOrEqual(host.x + host.width);
  expect(await shown.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
}

async function bitmap(page: Page, n = 2) {
  return page.evaluate((n) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    if (!probe) throw new Error("차트 이미지가 없습니다");
    return probe.chart.takeScreenshot(true, false).toDataURL();
  }, n);
}

async function legend(locator: Locator) {
  return locator.locator("[data-price-row], [data-ohlc]").allTextContents();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installChartProbe);
  await page.route("**/api/bars?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { symbol: query.get("symbol"), venue: query.get("venue"), period: query.get("period"), bars: query.get("period") === "5m" ? intraday : daily, current: null, nextBefore: null, seq: null } });
  });
});

for (const [source, follower, symbol] of [
  ["D", "5m", "005930"],
  ["5m", "D", "005930"],
  ["D", "D", "000660"],
  ["D", "D", "005930"],
] satisfies [Period, Period, string][]) {
  test(`${source} → ${follower} ${symbol}: 시각을 맞추고 범례·가격선·이미지를 지킨다`, async ({ page, scenario }) => {
    seed(scenario, source, follower, symbol);
    await ready(page);
    const beforeLegend = await legend(cell(page, 2));
    const beforeBitmap = await bitmap(page);
    const range = await page.evaluate(() => window.chartProbes[1]?.chart.timeScale().getVisibleLogicalRange());
    const sourceTime = TARGET + (source === "5m" ? 9 * 3600 + 1500 : 0);
    const followerTime = TARGET + (follower === "5m" ? 9 * 3600 : 0);
    await point(page, 1, sourceTime);
    await markerAt(page, 2, followerTime);
    await expect(marker(page)).toHaveText(follower === "5m" ? "2026-11-08 09:00" : "2026-11-08");
    expect(await legend(cell(page, 2))).toEqual(beforeLegend);
    expect(await bitmap(page)).toBe(beforeBitmap);
    expect(await page.evaluate(() => window.chartProbes[1]?.chart.timeScale().getVisibleLogicalRange())).toEqual(range);
    const children = await marker(page).locator("div").all();
    expect(children).toHaveLength(2);
    expect(await children[0]?.evaluate((line) => line.style.width)).toBe("0px");
    await point(page, 1, sourceTime + DAY);
    await markerAt(page, 2, followerTime + DAY);
    await page.mouse.move(2, 2);
    await expect(marker(page)).toBeHidden();
  });
}

const layoutButton = (page: Page) => page.getByRole("button", { name: /^레이아웃:/ });
const radio = (page: Page, name: string) => page.getByRole("menuitemradio", { name, exact: true });

async function chooseCrosshair(page: Page, name: string) {
  await layoutButton(page).click();
  await radio(page, name).click();
}

async function expectCrosshairChoice(page: Page, name: string) {
  await layoutButton(page).click();
  await expect(radio(page, name)).toHaveAttribute("aria-checked", "true");
  for (const other of ["끔", "모든 차트", "같은 종목", "같은 연동 색"].filter((n) => n !== name)) await expect(radio(page, other)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
}

type ScopeChart = { period: Period; symbol: string; link: LayoutWindow["link"] };

function seedCharts(scenario: Scenario, charts: ScopeChart[], sync?: Partial<LayoutSync>) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = charts.map(({ period, symbol, link }, i) => ({ id: `cell-${i}`, link, kind: "chart", symbol, venue: "combined", period, chartSettings: SETTINGS }));
  const groups = charts.map((_, i) => ({ kind: "group", id: `g${i}`, tabs: [`cell-${i}`], active: `cell-${i}` }));
  const root = groups.slice(0, -1).reduceRight<Record<string, unknown>>((second, first) => ({ kind: "split", dir: "row", ratio: 1 / 2, first, second }), groups[groups.length - 1]!);
  scenario.documents.saveLayout({ ...layout, sync: { ...layout.sync, ...sync }, windows, placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
}

async function readyAll(page: Page, count: number) {
  await page.goto("/");
  for (let n = 1; n <= count; n++) await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbes?.length ?? 0)).toBeGreaterThanOrEqual(count);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
}

test("십자선 연동 끄기는 즉시 지우고 저장되며 범위를 남긴 채 다시 켜도 이전 위치를 재생하지 않는다", async ({ page, scenario }) => {
  seed(scenario, "D", "D");
  await ready(page);
  await point(page, 1, TARGET);
  await expect(marker(page)).toBeVisible();
  await expectCrosshairChoice(page, "모든 차트");
  await chooseCrosshair(page, "끔");
  await expect(marker(page)).toBeHidden();
  await pollSaved(() => scenario.documents.layout().sync).toEqual({ crosshair: false, scroll: true, crosshairScope: "all" });
  await point(page, 1, LAST);
  await expect(marker(page)).toBeHidden();
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expectCrosshairChoice(page, "끔");
  await chooseCrosshair(page, "모든 차트");
  await expect(marker(page)).toBeHidden();
  await point(page, 1, TARGET);
  await expect(marker(page)).toBeVisible();
});

test("메뉴에서 고른 범위는 저장되고 새로고침 뒤 같은 라디오에 체크가 있으며 끔을 골라도 범위는 남는다", async ({ page, scenario }) => {
  seed(scenario, "D", "D");
  await ready(page);
  await chooseCrosshair(page, "같은 연동 색");
  await pollSaved(() => scenario.documents.layout().sync).toEqual({ crosshair: true, scroll: true, crosshairScope: "link" });
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expectCrosshairChoice(page, "같은 연동 색");
  await chooseCrosshair(page, "같은 종목");
  await pollSaved(() => scenario.documents.layout().sync.crosshairScope).toBe("symbol");
  await chooseCrosshair(page, "끔");
  await pollSaved(() => scenario.documents.layout().sync).toEqual({ crosshair: false, scroll: true, crosshairScope: "symbol" });
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expectCrosshairChoice(page, "끔");
  await layoutButton(page).click();
  await expect(radio(page, "같은 종목")).toHaveAttribute("aria-checked", "false");
  await radio(page, "같은 종목").click();
  await pollSaved(() => scenario.documents.layout().sync).toEqual({ crosshair: true, scroll: true, crosshairScope: "symbol" });
});

test("범위가 없는 저장된 레이아웃은 모든 차트로 열리고 종목과 색에 상관없이 따른다", async ({ page, scenario }) => {
  seed(scenario, "D", "D", "000660");
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, sync: { crosshair: true, scroll: true } as unknown as LayoutSync, revision: layout.revision + 1 });
  await ready(page);
  await expectCrosshairChoice(page, "모든 차트");
  await point(page, 1, TARGET);
  await markerAt(page, 2, TARGET);
});

test("같은 종목 범위는 같은 종목의 다른 주기 차트만 따르고 종목을 맞추면 그 뒤로 따른다", async ({ page, scenario }) => {
  seedCharts(scenario, [
    { period: "D", symbol: "005930", link: null },
    { period: "5m", symbol: "005930", link: null },
    { period: "D", symbol: "000660", link: null },
  ], { crosshairScope: "symbol" });
  await readyAll(page, 3);
  await point(page, 1, TARGET);
  await markerAt(page, 2, TARGET + 9 * 3600);
  await expect(marker(page, 3)).toBeHidden();
  await page.mouse.move(2, 2);
  await expect(marker(page, 2)).toBeHidden();
  await cell(page, 3).focus();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색", exact: true });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("005930");
  await dialog.getByRole("option").filter({ hasText: "005930" }).click();
  await expect(cell(page, 3)).toHaveAttribute("aria-busy", "false");
  await point(page, 1, TARGET);
  await markerAt(page, 3, TARGET);
  await markerAt(page, 2, TARGET + 9 * 3600);
});

test("같은 연동 색 범위는 같은 색 차트만 따르고 연동 색이 꺼진 차트는 보내지도 받지도 않는다", async ({ page, scenario }) => {
  seedCharts(scenario, [
    { period: "D", symbol: "005930", link: "a" },
    { period: "5m", symbol: "005930", link: "a" },
    { period: "D", symbol: "005930", link: "b" },
    { period: "D", symbol: "005930", link: null },
  ], { crosshairScope: "link" });
  await readyAll(page, 4);
  await point(page, 1, TARGET);
  await markerAt(page, 2, TARGET + 9 * 3600);
  await expect(marker(page, 3)).toBeHidden();
  await expect(marker(page, 4)).toBeHidden();
  await page.mouse.move(2, 2);
  await point(page, 4, TARGET);
  await expect(marker(page, 1)).toBeHidden();
  await expect(marker(page, 2)).toBeHidden();
  await expect(marker(page, 3)).toBeHidden();
  await page.mouse.move(2, 2);
  await point(page, 3, TARGET);
  await expect(marker(page, 1)).toBeHidden();
  await expect(marker(page, 2)).toBeHidden();
  await expect(marker(page, 4)).toBeHidden();
});

test("없는 시각과 화면 밖 봉은 표시하거나 과거 봉을 요청하지 않는다", async ({ page, scenario }) => {
  seed(scenario, "D", "5m");
  const requests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/bars") requests.push(request.url()); });
  await ready(page);
  const before = [...requests];
  await point(page, 1, LAST - 10 * DAY);
  await expect(marker(page)).toBeHidden();
  expect(requests).toEqual(before);
  await point(page, 1, TARGET);
  await expect(marker(page)).toBeVisible();
  await page.evaluate(() => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 2: "));
    probe?.chart.timeScale().setVisibleLogicalRange({ from: 25, to: 40 });
  });
  await expect(marker(page)).toBeHidden();
  const afterRange = [...requests];
  await point(page, 1, LAST - 2 * DAY);
  await expect(marker(page)).toBeHidden();
  expect(requests).toEqual(afterRange);
});

test("숨긴 탭은 참여하지 않고 다시 보일 때 이전 십자선을 재생하지 않는다", async ({ page, scenario }) => {
  seed(scenario, "D", "D", "000660", true);
  await ready(page);
  const parked = page.locator('section[aria-label^="칸 3:"] [data-synced-crosshair]');
  await point(page, 1, TARGET);
  await expect(marker(page)).toBeVisible();
  await expect(parked).toBeHidden();
  await tabs(page, 1).getByRole("tab", { name: /^삼성화재/ }).evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(cell(page, 3)).toBeVisible();
  await expect(marker(page)).toBeHidden();
  await expect(parked).toBeHidden();
  await page.evaluate(() => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 3: "));
    probe?.chart.timeScale().setVisibleLogicalRange({ from: 30, to: 85 });
  });
  await frames(page);
  await point(page, 3, TARGET);
  await expect(marker(page)).toBeVisible();
  await page.evaluate(() => {
    window.nativeCrosshairEvents = [];
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 3: "));
    probe?.chart.subscribeCrosshairMove(({ time }) => { window.nativeCrosshairEvents.push(typeof time === "number" ? time : null); });
  });
  await tabs(page, 2).getByRole("tab", { name: /^관심종목/ }).evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(cell(page, 2)).toHaveCount(0);
  await frames(page);
  await expect(page.locator('section[aria-label^="칸 2:"] [data-synced-crosshair]')).toHaveJSProperty("hidden", true);
  const beforeReopen = await page.evaluate(() => window.nativeCrosshairEvents.length);
  await tabs(page, 2).getByRole("tab", { name: /^SK하이닉스/ }).evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(cell(page, 2)).toBeVisible();
  await frames(page);
  const events = await page.evaluate(() => window.nativeCrosshairEvents);
  if (events.length === beforeReopen) await expect(marker(page)).toBeHidden();
  else {
    const time = events.at(-1);
    if (time == null) await expect(marker(page)).toBeHidden();
    else await markerAt(page, 2, fromChartTime(time));
  }
  await point(page, 3, LAST);
  await markerAt(page, 2, LAST);
});

test("연동이 켜진 따르는 차트에서 추세선을 그릴 수 있다", async ({ page, scenario }) => {
  seed(scenario, "D", "D", "000660");
  await ready(page);
  await point(page, 1, TARGET);
  await expect(marker(page)).toBeVisible();
  await cell(page, 2).focus();
  await page.keyboard.press("T");
  const box = await chartOf(cell(page, 2)).boundingBox();
  if (!box) throw new Error("따르는 차트가 없습니다");
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.4, { steps: 10 });
  await page.mouse.up();
  await pollSaved(() => scenario.documents.drawings("000660").length).toBe(1);
  expect(scenario.documents.drawings("000660")[0]?.tool).toBe("trendline");
});


test("포인터를 멈춘 채 휠로 확대해도 보내는 차트의 새 시각을 따른다", async ({ page, scenario }) => {
  seed(scenario, "D", "D", "000660");
  await ready(page);
  await page.evaluate(() => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    probe?.chart.subscribeCrosshairMove(({ time }) => { window.pointedCrosshairTime = typeof time === "number" ? time : null; });
  });
  const start = LAST - 20 * DAY;
  await point(page, 1, start);
  await markerAt(page, 2, start);
  await page.mouse.wheel(0, -250);
  await expect.poll(() => page.evaluate(() => window.pointedCrosshairTime)).not.toBe(toChartTime(start));
  await frames(page);
  const target = await page.evaluate(() => window.pointedCrosshairTime);
  if (target === null) throw new Error("확대 뒤 십자선 시각이 없습니다");
  await markerAt(page, 2, fromChartTime(target));
});
