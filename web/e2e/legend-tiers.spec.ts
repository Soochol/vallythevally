import type { Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, expect, saveChartShare, type Scenario, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const MA_PERIODS = [5, 10, 20, 60, 120, 200, 240];
const COLORS = ["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"] as const;

function movingAverages(count: number): ChartSettings["indicators"] {
  return MA_PERIODS.slice(0, count).map((period, i) => ({
    id: `ma${period}`,
    spec: { kind: "ma", method: "sma", period },
    panel: "price",
    visible: true,
    style: { colors: [COLORS[i % COLORS.length]!], width: 1 },
  }));
}

function chartWindow(id: string, settings: Partial<ChartSettings>, period: Period = "D"): LayoutWindow {
  return { id, kind: "chart", link: null, symbol: "005930", venue: "combined", period, chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 40, ...settings, indicators: [...DEFAULT_CHART_SETTINGS.indicators, ...(settings.indicators ?? [])] } };
}

type DockNode = object;

function evenSplit(nodes: DockNode[], dir: "row" | "column"): DockNode {
  const [first, ...rest] = nodes;
  if (!first) throw new Error("나눌 칸이 없습니다");
  return rest.length === 0 ? first : { kind: "split", dir, ratio: 1 / nodes.length, first, second: evenSplit(rest, dir) };
}

function gridPlacement(rows: string[][]) {
  const lines = rows.map((ids) => evenSplit(ids.map((id) => ({ kind: "group", id: `g-${id}`, tabs: [id], active: id })), "row"));
  return { v: 1, dock: { root: evenSplit(lines, "column"), floats: [] }, canvas: null };
}

function seedCharts(scenario: Scenario, windows: LayoutWindow[], options: { keepOthers?: boolean; rows?: string[][] } = {}) {
  const layout = scenario.documents.layout();
  const others = options.keepOthers ? layout.windows.filter((window) => window.kind !== "chart") : [];
  const placement = options.rows ? gridPlacement(options.rows) : {};
  scenario.documents.saveLayout({ ...layout, windows: [...windows, ...others], placement, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "dock" });
}

async function frames(page: Page, count = 12) {
  await page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function ready(page: Page, n = 1) {
  await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(page.locator("[data-legend-tier]").nth(n - 1)).toHaveAttribute("data-legend-tier", /^(compact|minimal)$/);
  await frames(page, 24);
}

interface Rect { x: number; y: number; right: number; bottom: number; width: number; height: number }
interface Measured {
  tier: string | undefined;
  density: string | undefined;
  chart: Rect;
  paneHeight: number;
  axisWidth: number;
  topMargin: number;
  bottomMargin: number;
  legend: Rect;
  legendTexts: Rect[];
  topBarY: number | null;
}

async function measure(page: Page, n = 1): Promise<Measured> {
  return page.evaluate((n) => {
    const probe = window.chartProbes.find(({ chart }) => chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    if (!probe) throw new Error("차트 좌표가 없습니다");
    const chart = probe.chart;
    const main = window.chartProbe?.chart === chart ? window.chartProbe.main : probe.main;
    const body = chart.chartElement().parentElement;
    const host = chart.chartElement().closest<HTMLElement>("[data-legend-tier]");
    const legend = body?.querySelector(".chart-legend");
    if (!body || !host || !legend) throw new Error("범례가 없습니다");
    const rect = (r: DOMRectReadOnly) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    const texts: Rect[] = [];
    const walker = document.createTreeWalker(legend, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || !(node.parentElement instanceof HTMLElement) || node.parentElement.closest("svg")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) texts.push(rect(r));
    }
    const range = chart.timeScale().getVisibleLogicalRange();
    let topBarY: number | null = null;
    if (range) {
      for (let index = Math.ceil(range.from); index <= Math.floor(range.to); index++) {
        const item = main.dataByIndex(index) as { high?: number } | null;
        const y = item?.high === undefined ? null : main.priceToCoordinate(item.high);
        if (y !== null && (topBarY === null || y < topBarY)) topBarY = y;
      }
    }
    const margins = chart.priceScale("right").options().scaleMargins;
    const chartBox = chart.chartElement().getBoundingClientRect();
    return {
      tier: host.dataset.legendTier,
      density: host.dataset.legendDensity,
      chart: rect(chartBox),
      paneHeight: chart.panes()[0]?.getHeight() ?? 0,
      axisWidth: chart.priceScale("right").width(),
      topMargin: margins?.top ?? 0,
      bottomMargin: margins?.bottom ?? 0,
      legend: rect(legend.getBoundingClientRect()),
      legendTexts: texts,
      topBarY,
    };
  }, n);
}

const stable = async (page: Page, n = 1) => {
  let last = "";
  let same = 0;
  await expect.poll(async () => {
    const now = JSON.stringify(await measure(page, n));
    same = now === last ? same + 1 : 0;
    last = now;
    return same;
  }).toBeGreaterThanOrEqual(3);
  return measure(page, n);
};

test("1440px 한 칸에 지표 일곱 개를 띄워도 봉이 범례 아래 끝 위로 그려지지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(7) })]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  await expect(page.locator("[data-legend-tier]").first()).toHaveAttribute("data-legend-tier", "compact");
  await expect(cell(page).getByRole("button", { name: /^지표 7/ })).toBeVisible();
  const measured = await stable(page);
  expect(measured.tier).toBe("compact");
  const legendBottom = measured.legend.bottom - measured.chart.y;
  expect(measured.topMargin * measured.paneHeight).toBeGreaterThanOrEqual(legendBottom);
  expect(measured.topBarY).not.toBeNull();
  expect(measured.topBarY!).toBeGreaterThanOrEqual(legendBottom - 0.5);
});

test("여덟 칸에서는 범례가 가격 패널의 30%를 넘지 않고 날짜 글자가 가격축 위로 넘치지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  const ids = Array.from({ length: 8 }, (_, i) => `cell-${i}`);
  seedCharts(scenario, ids.map((id) => chartWindow(id, { indicators: movingAverages(5) })), { rows: [ids.slice(0, 4), ids.slice(4)] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  for (let n = 1; n <= 8; n++) await ready(page, n);
  await expect(page.locator("[data-legend-tier]").first()).toHaveAttribute("data-legend-tier", "minimal");
  const measured = await stable(page, 1);
  expect(measured.chart.width).toBeLessThan(340);
  expect(measured.tier).toBe("minimal");
  expect(measured.legend.height).toBeLessThanOrEqual(measured.paneHeight * 0.3);
  const plotRight = measured.chart.right - measured.axisWidth;
  for (const text of measured.legendTexts) expect(text.right).toBeLessThanOrEqual(plotRight + 0.5);
});

test("폭 280px 칸의 범례는 한 줄과 지표 알약이고 알약을 누르면 지표 값이 펼쳐진다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(4) })], { keepOthers: true });
  saveChartShare(scenario, 0.22);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  const pill = cell(page).getByRole("button", { name: /^지표 4/ });
  await expect(page.locator("[data-legend-tier]").first()).toHaveAttribute("data-legend-tier", "minimal");
  await expect(pill).toBeVisible();
  const measured = await stable(page);
  expect(measured.chart.width).toBeGreaterThan(265);
  expect(measured.chart.width).toBeLessThan(295);
  expect(measured.tier).toBe("minimal");
  const rows = cell(page).locator(".chart-legend [data-indicator-row]:visible");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);
  await expect(cell(page).locator("[data-legend-head] [role=heading]")).toBeVisible();
  await pill.click();
  await page.mouse.move(0, 0);
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toHaveCount(4);
  await expect(rows.first().locator(":scope > span.font-medium")).not.toBeEmpty();
});

test("십자선을 열 번 움직여도 범례 단계와 가격 패널 위 여백이 바뀌지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(7) })]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  const before = await stable(page);
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("[data-chart-overlay-host]");
    if (!host) throw new Error("차트 칸이 없습니다");
    const mutations: string[] = [];
    new MutationObserver((records) => { for (const record of records) mutations.push(record.attributeName ?? ""); }).observe(host, { attributes: true, attributeFilter: ["data-legend-tier", "data-legend-density", "style"] });
    (window as unknown as { legendMutations: string[] }).legendMutations = mutations;
  });
  const box = before.chart;
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * 0.5);
    await frames(page, 2);
    const during = await measure(page);
    expect(during.tier).toBe(before.tier);
    expect(during.density).toBe(before.density);
    expect(during.topMargin).toBe(before.topMargin);
  }
  expect(await page.evaluate(() => (window as unknown as { legendMutations: string[] }).legendMutations)).toEqual([]);
});

test("화면 내 최고 꼬리표는 범례 상자와 겹치지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  const source: BarsPage = scenario.market.page({ symbol: "005930", venue: "combined", period: "D", limit: 500 });
  const peak = source.bars.length - 38;
  const bars = source.bars.map((bar, i) => (i === peak ? { ...bar, h: Math.round(bar.h * 1.35) } : bar));
  scenario.on((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930", () => ({ body: { ...source, bars } }));
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(7), showExtremes: true })]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  const measured = await stable(page);
  const tag = cell(page).locator('.chart-extreme[data-extreme="high"]');
  await expect(tag.locator("> span")).toBeVisible();
  const dot = await tag.locator("> i").boundingBox();
  const label = await tag.locator("> span").boundingBox();
  if (!dot || !label) throw new Error("최고 꼬리표가 없습니다");
  expect(dot.x + dot.width / 2).toBeLessThan(measured.legend.right);
  const apart = label.x + label.width <= measured.legend.x || measured.legend.right <= label.x || label.y + label.height <= measured.legend.y || measured.legend.bottom <= label.y;
  expect(apart).toBe(true);
  expect(label.y).toBeGreaterThanOrEqual(measured.chart.y + 8 - 0.5);
  expect(measured.topBarY).not.toBeNull();
  expect(await page.evaluate((time) => window.chartProbe.chart.timeScale().timeToCoordinate(time) !== null, toChartTime(source.bars[peak]!.t))).toBe(true);
});

test("바로가기 모드의 알약은 범례 밖 상단 중앙에 있고 범례가 펼쳐져도 겹치거나 밀리지 않으며 닫기 버튼 이름은 바로가기 끝내기다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { visibleBars: 50 }, "D"), chartWindow("cell-1", { visibleBars: 50, indicators: movingAverages(4) }, "5m")], { rows: [["cell-0", "cell-1"]] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-09T10:00:00+09:00"));
  await page.goto("/");
  await ready(page, 1);
  await ready(page, 2);
  await page.evaluate(() => {
    const probe = window.chartProbes.find(({ chart }) => chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const count = Number(probe?.chart.chartElement().closest("section")?.querySelector("[data-bar-count]")?.getAttribute("data-bar-count"));
    const last = count - 1 - 8;
    probe?.chart.timeScale().setVisibleLogicalRange({ from: last - 49, to: last });
  });
  await frames(page, 4);
  const daily = scenario.market.page({ symbol: "005930", period: "D" });
  const clicked = (daily.current ? [...daily.bars, daily.current] : daily.bars).at(-21);
  if (!clicked) throw new Error("가리킬 일봉이 없습니다");
  const target = await page.evaluate((time) => {
    const probe = window.chartProbes.find(({ chart }) => chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const x = probe?.chart.timeScale().timeToCoordinate(time);
    const box = probe?.chart.chartElement().getBoundingClientRect();
    if (!probe || x === null || x === undefined || !box) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.4 };
  }, toChartTime(clicked.t));
  await page.mouse.click(target.x, target.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^바로가기 · / }).click();

  const pane = cell(page, 2);
  const badge = pane.getByRole("group", { name: "바로가기 모드" });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/과거 보기 \d{4}-\d{2}-\d{2} · 실시간 멈춤/);
  await expect(pane.locator(".chart-legend").getByRole("group", { name: "바로가기 모드" })).toHaveCount(0);
  await expect(pane.locator("[data-legend-head]").getByRole("group", { name: "바로가기 모드" })).toHaveCount(0);
  await frames(page, 8);

  const chartBox = (await chartOf(pane).boundingBox())!;
  const badgeBoxBefore = (await badge.boundingBox())!;
  const legendBoxBefore = (await pane.locator(".chart-legend").boundingBox())!;
  expect(Math.abs((badgeBoxBefore.x + badgeBoxBefore.width / 2) - (chartBox.x + chartBox.width / 2))).toBeLessThanOrEqual(2);
  expect(badgeBoxBefore.y).toBeGreaterThanOrEqual(chartBox.y);
  expect(badgeBoxBefore.y + badgeBoxBefore.height).toBeLessThanOrEqual(legendBoxBefore.y + 0.5);

  const foldPill = pane.getByRole("button", { name: /^지표 4/ });
  await expect(foldPill).toHaveAttribute("aria-expanded", "true");
  await foldPill.click();
  await expect(foldPill).toHaveAttribute("aria-expanded", "false");
  await frames(page, 6);

  const badgeBoxFolded = (await badge.boundingBox())!;
  const legendBoxFolded = (await pane.locator(".chart-legend").boundingBox())!;
  expect(Math.abs(badgeBoxFolded.x - badgeBoxBefore.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(badgeBoxFolded.y - badgeBoxBefore.y)).toBeLessThanOrEqual(0.5);
  expect(badgeBoxFolded.y + badgeBoxFolded.height).toBeLessThanOrEqual(legendBoxFolded.y + 0.5);

  await foldPill.click();
  await expect(foldPill).toHaveAttribute("aria-expanded", "true");
  await frames(page, 6);

  const badgeBoxAfter = (await badge.boundingBox())!;
  const legendBoxAfter = (await pane.locator(".chart-legend").boundingBox())!;
  expect(Math.abs(badgeBoxAfter.x - badgeBoxBefore.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(badgeBoxAfter.y - badgeBoxBefore.y)).toBeLessThanOrEqual(0.5);
  expect(badgeBoxAfter.y + badgeBoxAfter.height).toBeLessThanOrEqual(legendBoxAfter.y + 0.5);

  const close = badge.getByRole("button", { name: "바로가기 끝내기", exact: true });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(24);
  expect(box?.height).toBeGreaterThanOrEqual(24);
  await close.click();
  await expect(badge).toBeHidden();
});

test("390px 휴대폰에서 지표 넷을 띄워도 봉이 보이는 가격 패널이 범례 높이의 두 배 이상이다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(4) })], { rows: [["cell-0"]] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await ready(page);
  const measured = await stable(page);
  expect(measured.tier).toBe("minimal");
  const visible = measured.paneHeight * (1 - measured.topMargin - measured.bottomMargin);
  expect(visible).toBeGreaterThanOrEqual(measured.legend.height * 2);
  await expect(cell(page).getByRole("button", { name: /^지표 4/ })).toBeVisible();
});

test("일봉과 분봉 차트 범례가 동일한 1줄 헤더로 통일되고 시고저종이 항상 보이며 량은 표시되지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(2) }, "D"), chartWindow("cell-1", { indicators: movingAverages(2) }, "5m")], { rows: [["cell-0", "cell-1"]] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page, 1);
  await ready(page, 2);
  for (const n of [1, 2]) {
    const current = cell(page, n);
    await expect(page.locator("[data-legend-tier]").nth(n - 1)).toHaveAttribute("data-legend-tier", "compact");
    await expect(current.locator("[data-legend-head] [data-price-row]")).toBeVisible();
    const ohlc = current.locator("[data-ohlc]");
    await expect(ohlc).toBeVisible();
    await expect(ohlc.locator(":scope > span")).toHaveCount(4);
    await expect(ohlc).toContainText(/시.+고.+저.+종/);
    await expect(ohlc).not.toContainText("량");
    await expect(current.locator('[data-indicator-row="ma5"] > [data-indicator-edit]')).toBeVisible();
  }
});

test("지표 4개는 기본 펼침으로 시작하고 버튼 1클릭으로 접고 다시 펼치며 접힌 상태에서 호버로 열리지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seedCharts(scenario, [chartWindow("cell-0", { indicators: movingAverages(4) }, "D")]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  const current = cell(page);
  const foldBox = current.locator("[data-indicator-fold-box]");
  const pill = current.getByRole("button", { name: /^지표 4/ });
  const thirdRow = current.locator('[data-indicator-row="ma20"]');
  await expect(foldBox).not.toHaveAttribute("data-folded", "");
  await expect(foldBox).not.toHaveAttribute("data-open", "");
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("▴");
  await expect(thirdRow).toBeVisible();
  await expect(current.getByRole("button", { name: "항상 펼치기", exact: true })).toHaveCount(0);

  await thirdRow.hover();
  await thirdRow.getByRole("button", { name: /숨기기/ }).click();
  await expect(thirdRow.getByRole("button", { name: /보이기/ })).toHaveCount(1);

  await page.mouse.move(0, 0);
  await expect(thirdRow).toBeVisible();

  await pill.click();
  await expect(foldBox).toHaveAttribute("data-folded", "");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(pill).toContainText("▾");
  await expect(thirdRow).toBeHidden();

  await pill.hover();
  await expect(foldBox).toHaveAttribute("data-folded", "");
  await expect(thirdRow).toBeHidden();

  await pill.click();
  await expect(foldBox).not.toHaveAttribute("data-folded", "");
  await expect(foldBox).not.toHaveAttribute("data-open", "");
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("▴");
  await expect(thirdRow).toBeVisible();
});
