import type { Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import { parseChartSettings } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { mirror } from "./drawing-probe";
import { installFinancialViewportProbe } from "./financial-viewport-probe";
import { financialTest, seedFinancialLayout, type FinancialFixture } from "./financial-update-helpers";
import { cell, chartOf, expect, firstChart, withFirstChart, type Scenario } from "./harness";

const year = (value: number) => Date.parse(`${value}-01-01T00:00:00+09:00`) / 1000;
const rayId = "01900000-0000-7000-8000-000000000903";
const shiftPixels = 120 * 0.8;

async function settledViewport(page: Page) {
  const view = await page.evaluate(async (time) => {
    let previous = "";
    let equalFrames = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scale = window.chartProbe.chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      const key = JSON.stringify([scale.width(), scale.options().barSpacing, range, document.querySelector(".drawing-mirror")?.getAttribute("data-drawings"), document.fonts.status]);
      equalFrames = key === previous ? equalFrames + 1 : 0;
      previous = key;
      if (equalFrames >= 4 && document.fonts.status === "loaded") {
        const x = scale.timeToCoordinate(time);
        if (x === null) throw new Error("2014년 가격 시각이 화면에 없습니다");
        return { range, spacing: scale.options().barSpacing, right: scale.width() - x, anchorIndex: scale.timeToIndex(time), locked: scale.options().lockVisibleTimeRangeOnResize };
      }
    }
    throw new Error("차트 시각이 멈추지 않았습니다");
  }, toChartTime(year(2014)));
  const ray = (await mirror(page)).find((drawing) => drawing.id === rayId)?.points[0]?.x ?? null;
  return { ...view, rayX: ray };
}

function seedChart(scenario: Scenario) {
  seedFinancialLayout(scenario);
  const bars = Array.from({ length: 20 }, (_, index) => ({ t: year(1997 + index), o: 80 + index * 5, h: 85 + index * 5, l: 75 + index * 5, c: 80 + index * 5, v: 1000 }));
  scenario.on("/api/bars", () => ({ body: { symbol: "005930", venue: "combined", period: "Y", bars: bars.slice(0, -1), current: bars.at(-1)!, nextBefore: null, seq: null } satisfies BarsPage }));
  scenario.documents.saveDrawing({ id: rayId, symbol: "005930", tool: "ray", points: [{ t: year(2012), price: 140 }, { t: year(2013), price: 150 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 } satisfies DrawingInput);
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { period: "Y", chartSettings: { ...parseChartSettings(firstChart(layout).chartSettings), visibleBars: 10 } }) });
  return scenario.documents.drawings("005930");
}

function revenueSnapshot(financial: FinancialFixture, version: number, years: readonly number[]): FinancialsPage {
  const response = financial.page("005930", "Y");
  response.refreshVersion = version;
  const source = response.series.find((series) => series.metric === "revenue")?.points.find((point) => point.status === "available");
  if (!source) throw new Error("매출액 재무 자료가 없습니다");
  response.series = response.series.map((series) => ({
    ...series,
    points: series.metric === "revenue" ? years.map((value) => ({ ...source, businessYear: value, priceBucket: year(value), period: { kind: "duration", start: `${value}-01-01`, end: `${value}-12-31` }, inputs: [] })) : [],
  }));
  return response;
}

const starts = {
  near: { dragPixels: 120, lastBarShown: true },
  lastBarHidden: { dragPixels: 700, lastBarShown: false },
  initialHeld: { dragPixels: 0, lastBarShown: true },
} as const;
const lastBarIndex = 19;

async function shiftAroundFinancialReplacement(page: Page, scenario: Scenario, financial: FinancialFixture, start: keyof typeof starts, replacement: "after first paint" | "before first paint") {
  const { dragPixels, lastBarShown } = starts[start];
  const stored = seedChart(scenario);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFinancialViewportProbe);
  const held = scenario.hold((url) => url.pathname === "/api/symbols/005930/financials");
  await page.goto("/");
  await held.received;
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "20");
  await expect.poll(() => page.evaluate(() => Boolean(window.chartProbe) && window.financialViewportProbe.hasController())).toBe(true);
  const initial = await settledViewport(page);
  const box = (await chartOf(cell(page)).boundingBox())!;
  if (dragPixels > 0) {
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15 + dragPixels, box.y + box.height * 0.35, { steps: 12 });
    await page.mouse.up();
  }
  const revealed = await settledViewport(page);
  if (dragPixels > 0) {
    expect(revealed.locked).toBe(false);
    expect(revealed.range!.to).toBeLessThan(initial.range!.to);
  } else {
    expect(revealed.locked).toBe(true);
    expect(revealed).toEqual(initial);
  }
  expect(revealed.rayX).not.toBeNull();
  expect(revealed.range!.to > lastBarIndex + 0.5).toBe(lastBarShown);

  held.reply({ body: revenueSnapshot(financial, 1, [2017, 2018]) });
  await expect.poll(() => page.evaluate(() => window.financialViewportProbe.deliveries.some((delivery) => delivery.page?.refreshVersion === 1))).toBe(true);
  const settled = await settledViewport(page);
  expect(settled).toEqual(revealed);

  await page.evaluate(() => { window.financialViewportProbe.scrolls.length = 0; window.financialViewportProbe.hold(); });
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Shift");
  await expect.poll(() => page.evaluate(() => window.financialViewportProbe.scrolls.length)).toBe(1);

  if (replacement === "after first paint") {
    await page.evaluate(() => window.financialViewportProbe.release());
    await settledViewport(page);
  }
  await page.evaluate((response) => window.financialViewportProbe.deliver(response), revenueSnapshot(financial, 2, [1995, 1996]));
  await expect.poll(() => page.evaluate(() => window.financialViewportProbe.deliveries.some((delivery) => delivery.page?.refreshVersion === 2))).toBe(true);
  if (replacement === "before first paint") await page.evaluate(() => window.financialViewportProbe.release());
  const after = await settledViewport(page);

  expect(after.anchorIndex! - settled.anchorIndex!).toBe(2);
  expect(after.spacing).toBe(settled.spacing);
  expect(after.right).toBeCloseTo(settled.right - shiftPixels, 1);
  expect(after.rayX).not.toBeNull();
  expect(after.rayX!).toBeCloseTo(settled.rayX! + shiftPixels, 0);
  expect(scenario.documents.drawings("005930")).toEqual(stored);
}

financialTest("가까이 끌어 둔 화면에서 재무 교체가 Shift 이동의 첫 paint 뒤에 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "near", "after first paint");
});

financialTest("가까이 끌어 둔 화면에서 재무 교체가 Shift 이동의 첫 paint보다 먼저 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "near", "before first paint");
});

financialTest("마지막 봉을 화면 밖으로 끈 화면에서 재무 교체가 Shift 이동의 첫 paint 뒤에 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "lastBarHidden", "after first paint");
});

financialTest("마지막 봉을 화면 밖으로 끈 화면에서 재무 교체가 Shift 이동의 첫 paint보다 먼저 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "lastBarHidden", "before first paint");
});

financialTest("초기 범위를 지키는 화면에서 재무 교체가 Shift 이동의 첫 paint 뒤에 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "initialHeld", "after first paint");
});

financialTest("초기 범위를 지키는 화면에서 재무 교체가 Shift 이동의 첫 paint보다 먼저 와도 이동이 남는다", async ({ page, scenario, financial }) => {
  await shiftAroundFinancialReplacement(page, scenario, financial, "initialHeld", "before first paint");
});
