import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { DrawingPoint } from "../src/api/generated/DrawingPoint";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { mirror } from "./drawing-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const SYMBOL = "005930";
const DRAWING_ID = "01900000-0000-7000-8000-000000000091";

function dailyBars(): Bar[] {
  const first = Date.UTC(2026, 3, 1) / 1000 - 9 * 3600;
  return Array.from({ length: 150 }, (_, index) => {
    const base = 70_000 + Math.sin(index / 10) * 4_000;
    return { t: first + index * 86_400, o: base, h: base + 1_200, l: base - 1_200, c: base + 300, v: 1_000_000 + index * 10_000 };
  });
}

function seedTrendline(scenario: Scenario): DrawingPoint[] {
  const bars = dailyBars();
  const points: DrawingPoint[] = [
    { t: bars[95]!.t, price: bars[95]!.l },
    { t: bars[130]!.t, price: bars[130]!.h },
  ];
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === SYMBOL && url.searchParams.get("period") === "D",
    { body: { symbol: SYMBOL, venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } },
  );
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = {
    v: 2,
    style: "candle",
    scale: "normal",
    compare: [],
    indicators: [
      { id: "volume", spec: { kind: "volume", maPeriod: null }, panel: "p-volume", visible: true, style: { colors: ["ind-1"], width: 1 } },
    ],
    panels: [{ id: "p-volume", stretch: 0.25 }],
  };
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, { symbol: SYMBOL, venue: "combined", period: "D", chartSettings }),
  });
  scenario.documents.saveDrawing({
    id: DRAWING_ID,
    symbol: SYMBOL,
    tool: "trendline",
    points,
    text: null,
    style: { line: { color: "$draw", width: 2, dash: "solid" } },
    locked: false,
    hidden: false,
    periods: null,
    z: 1,
    group: null,
    scope: { kind: "symbol" },
    revision: 1,
  });
  return points;
}

async function chartCoords(page: Page, points: readonly DrawingPoint[]): Promise<({ x: number; y: number } | null)[]> {
  const chartTimes = points.map((point) => toChartTime(point.t));
  return page.evaluate(({ points, chartTimes }) => {
    const { chart, main } = window.chartProbe;
    const timeScale = chart.timeScale();
    return points.map((point, index) => {
      const x = timeScale.timeToCoordinate(chartTimes[index]!);
      const y = main.priceToCoordinate(point.price);
      return x === null || y === null ? null : { x, y };
    });
  }, { points, chartTimes });
}

async function maxDrift(page: Page, points: readonly DrawingPoint[]): Promise<number> {
  const [shown, expected] = await Promise.all([mirror(page), chartCoords(page, points)]);
  const line = shown.find((item) => item.id === DRAWING_ID);
  if (!line || line.points.length !== expected.length) return Infinity;
  let worst = 0;
  for (let index = 0; index < expected.length; index++) {
    const a = line.points[index];
    const b = expected[index];
    if (!a || !b) return Infinity;
    worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return worst;
}

async function openSeeded(page: Page, scenario: Scenario): Promise<DrawingPoint[]> {
  const points = seedTrendline(scenario);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => maxDrift(page, points)).toBeLessThanOrEqual(1);
  return points;
}

test("가격축을 끈 뒤 마우스를 움직이지 않아도 드로잉 점이 새 좌표와 맞는다", async ({ page, scenario }) => {
  const points = await openSeeded(page, scenario);
  const before = await chartCoords(page, points);
  const box = (await chartOf(cell(page)).boundingBox())!;
  const paneHeight = await page.evaluate(() => window.chartProbe.chart.panes()[0]!.getHeight());
  const axisX = box.x + box.width - 20;
  const startY = box.y + paneHeight * 0.35;
  await page.mouse.move(axisX, startY);
  await page.mouse.down();
  await page.mouse.move(axisX, startY + 90, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await chartCoords(page, points);
    return Math.abs((after[0]?.y ?? 0) - (before[0]?.y ?? 0)) + Math.abs((after[1]?.y ?? 0) - (before[1]?.y ?? 0));
  }).toBeGreaterThan(10);
  await expect.poll(() => maxDrift(page, points)).toBeLessThanOrEqual(1);
});

test("창 크기를 바꾼 뒤 마우스를 움직이지 않아도 드로잉 점이 새 좌표와 맞는다", async ({ page, scenario }) => {
  const points = await openSeeded(page, scenario);
  const beforeBox = (await chartOf(cell(page)).boundingBox())!;
  const before = await chartCoords(page, points);
  await page.setViewportSize({ width: 920, height: 600 });
  await expect.poll(async () => {
    const afterBox = (await chartOf(cell(page)).boundingBox())!;
    return Math.min(beforeBox.width - afterBox.width, beforeBox.height - afterBox.height);
  }).toBeGreaterThan(50);
  await expect.poll(async () => {
    const after = await chartCoords(page, points);
    return Math.abs((after[0]?.x ?? 0) - (before[0]?.x ?? 0)) + Math.abs((after[0]?.y ?? 0) - (before[0]?.y ?? 0));
  }).toBeGreaterThan(10);
  await expect.poll(() => maxDrift(page, points)).toBeLessThanOrEqual(1);
});

test("지표 패널 높이를 바꾼 뒤 마우스를 움직이지 않아도 드로잉 점이 새 좌표와 맞는다", async ({ page, scenario }) => {
  const points = await openSeeded(page, scenario);
  const beforeHeight = await page.evaluate(() => window.chartProbe.chart.panes()[0]!.getHeight());
  const before = await chartCoords(page, points);
  const handle = cell(page).locator('[data-panel-resize="p-volume"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2 - 80, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.panes()[0]!.getHeight())).toBeLessThan(beforeHeight - 40);
  await expect.poll(async () => {
    const after = await chartCoords(page, points);
    return Math.abs((after[0]?.y ?? 0) - (before[0]?.y ?? 0));
  }).toBeGreaterThan(5);
  await expect.poll(() => maxDrift(page, points)).toBeLessThanOrEqual(1);
});
