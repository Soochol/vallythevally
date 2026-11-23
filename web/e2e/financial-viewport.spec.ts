import { writeFile } from "node:fs/promises";
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
const markerId = "01900000-0000-7000-8000-000000000903";
type Insertion = "unchanged" | "prepend" | "append";
type Limit = "minimum" | "maximum";

async function viewport(page: Page) {
  const result = await page.evaluate(async (time) => {
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
        if (x === null) throw new Error("Missing price time anchor");
        return { range, spacing: scale.options().barSpacing, width: scale.width(), right: scale.width() - x };
      }
    }
    throw new Error("Financial viewport did not settle");
  }, toChartTime(year(2014)));
  const drawings = await mirror(page);
  return { ...result, drawings, targetX: drawings.find((drawing) => drawing.id === markerId)?.points[0]?.x ?? null };
}

function seed(scenario: Scenario) {
  seedFinancialLayout(scenario);
  const bars = Array.from({ length: 20 }, (_, index) => ({ t: year(1997 + index), o: 80 + index * 5, h: 85 + index * 5, l: 75 + index * 5, c: 80 + index * 5, v: 1000 }));
  scenario.on("/api/bars", () => ({ body: { symbol: "005930", venue: "combined", period: "Y", bars: bars.slice(0, -1), current: bars.at(-1)!, nextBefore: null, seq: null } satisfies BarsPage }));
  scenario.documents.saveDrawing({ id: markerId, symbol: "005930", tool: "ray", points: [{ t: year(2000), price: 100 }, { t: year(2001), price: 110 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 } satisfies DrawingInput);
  return scenario.documents.drawings("005930");
}

function financialPage(financial: FinancialFixture, insertion: Insertion, version: number): FinancialsPage {
  const response = financial.page("005930", "Y");
  response.refreshVersion = version;
  if (insertion === "unchanged") return response;
  const source = response.series.find((series) => series.metric === "revenue")?.points.find((point) => point.status === "available");
  if (!source) throw new Error("Missing available financial fixture");
  const years = insertion === "prepend" ? [1995, 1996] : [2017, 2018];
  response.series = response.series.map((series) => ({ ...series, points: series.metric === "revenue" ? years.map((value) => ({ ...source, businessYear: value, priceBucket: year(value), period: { kind: "duration", start: `${value}-01-01`, end: `${value}-12-31` }, inputs: [] })) : [] }));
  return response;
}

async function open(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { period: "Y", chartSettings: { ...parseChartSettings(firstChart(layout).chartSettings), visibleBars: 10 } }) });
  const held = scenario.hold((url) => url.pathname === "/api/symbols/005930/financials");
  await page.goto("/");
  await held.received;
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "20");
  await expect.poll(() => page.evaluate(() => Boolean(window.chartProbe) && window.financialViewportProbe.hasController())).toBe(true);
  return held;
}

async function selectMarker(page: Page) {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const [from, to] = (await mirror(page)).find((drawing) => drawing.id === markerId)!.points;
  const y = box.height * 0.1;
  const x = from!.x! + ((y - from!.y!) * (to!.x! - from!.x!)) / (to!.y! - from!.y!);
  await page.mouse.click(box.x + x, box.y + y);
}

async function delivered(page: Page, version: number) {
  await expect.poll(() => page.evaluate((value) => window.financialViewportProbe.deliveries.some((delivery) => delivery.page?.refreshVersion === value), version)).toBe(true);
}

const frame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

for (const limit of ["minimum", "maximum"] satisfies Limit[]) financialTest(`a wheel that cannot move the ${limit} zoom limit keeps the pending financial correction`, async ({ page, scenario, financial }, info) => {
  const stored = seed(scenario);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFinancialViewportProbe);
  const results = [];
  for (const order of ["correction painted", "correction pending"]) {
    const held = await open(page, scenario);
    await page.evaluate(() => window.financialViewportProbe.hold());
    await selectMarker(page);
    await page.evaluate(() => window.financialViewportProbe.release());
    await expect.poll(async () => (await mirror(page)).find((drawing) => drawing.id === markerId)?.selected).toBe(true);
    await viewport(page);
    held.reply({ body: financialPage(financial, "append", 1) });
    await delivered(page, 1);
    await viewport(page);
    const box = (await chartOf(cell(page)).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
    const direction = limit === "minimum" ? 120 : -120;
    for (let index = 0; index < 50; index++) {
      await page.mouse.wheel(0, direction);
      await frame(page);
    }
    const limited = await viewport(page);
    expect(limited.spacing).toBe(limit === "minimum" ? 0.5 : limited.width / 2);
    await page.evaluate(() => window.financialViewportProbe.hold());
    const beforeCorrection = await page.evaluate(() => window.financialViewportProbe.scrolls.length);
    await page.evaluate((response) => window.financialViewportProbe.deliver(response), financialPage(financial, "prepend", 2));
    const queued = await page.evaluate((count) => window.financialViewportProbe.scrolls.slice(count), beforeCorrection);
    expect(queued).toHaveLength(1);
    if (order === "correction painted") {
      await page.evaluate(() => window.financialViewportProbe.release());
      await viewport(page);
    }
    const beforeInput = await page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange());
    await page.mouse.wheel(0, direction);
    const afterInput = await page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange());
    expect(afterInput).toEqual(beforeInput);
    if (order === "correction pending") await page.evaluate(() => window.financialViewportProbe.release());
    results.push({ order, limited, queued, after: await viewport(page), stored: scenario.documents.drawings("005930") });
  }
  await writeFile(info.outputPath("no-op-wheel.json"), JSON.stringify(results, null, 2));
  for (const result of results) expect(result.stored).toEqual(stored);
  const [painted, pending] = results.map((result) => result.after);
  expect(pending!.spacing).toBeCloseTo(painted!.spacing, 6);
  expect(pending!.right).toBeCloseTo(painted!.right, 2);
  expect(pending!.range!.from).toBeCloseTo(painted!.range!.from, 6);
  expect(pending!.range!.to).toBeCloseTo(painted!.range!.to, 6);
  expect(pending!.targetX).toBeCloseTo(painted!.targetX!, 2);
});
