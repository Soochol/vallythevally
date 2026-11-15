import type { Page } from "@playwright/test";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import { installChartProbe } from "./chart-probe";
import { drawings, mirror } from "./drawing-probe";
import { cell, chartOf, expect, test, type Scenario } from "./harness";

function seed(scenario: Scenario) {
  const common = { symbol: "IDX:001", text: null, style: {}, locked: false, hidden: false, periods: null, group: null, scope: { kind: "symbol" }, revision: 1 } satisfies Omit<DrawingInput, "id" | "tool" | "points" | "z">;
  scenario.documents.saveDrawing({ ...common, id: "01900000-0000-7000-8000-000000000901", tool: "ray", points: [{ t: 1783868400, price: 5106.515354437399 }, { t: 1785423600, price: 5352.915084197957 }], z: 1 });
  scenario.documents.saveDrawing({ ...common, id: "01900000-0000-7000-8000-000000000902", tool: "crossline", points: [{ t: 1791817200, price: 5845.714344262295 }], z: 2 });
}

async function settledViewport(page: Page) {
  await chartOf(cell(page)).evaluate(async () => {
    let previous = "";
    let equalFrames = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scale = window.chartProbe.chart.timeScale();
      const key = JSON.stringify([scale.width(), scale.options().barSpacing, scale.getVisibleLogicalRange(), document.querySelector(".drawing-mirror")?.getAttribute("data-drawings"), document.fonts.status]);
      equalFrames = key === previous ? equalFrames + 1 : 0;
      previous = key;
      if (equalFrames >= 4 && document.fonts.status === "loaded") return;
    }
    throw new Error("Chart viewport did not settle");
  });
  return page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    return { width: scale.width(), spacing: scale.options().barSpacing, range: scale.getVisibleLogicalRange(), locked: scale.options().lockVisibleTimeRangeOnResize };
  });
}

async function controlledReload(page: Page, scenario: Scenario, order: "bars-first" | "drawings-first", takeover?: () => Promise<void>) {
  const bars = scenario.hold("/api/bars");
  const docs = scenario.hold("/api/drawings");
  await page.goto("/");
  const [request] = await Promise.all([bars.received, docs.received]);
  await expect.poll(() => page.evaluate(() => Boolean(window.chartProbe))).toBe(true);
  const body = scenario.market.page({ symbol: "IDX:001", period: "D", venue: null, limit: Number(new URL(request.url()).searchParams.get("limit") ?? 500), before: null });
  const stored = await drawings(scenario);
  if (order === "bars-first") {
    bars.reply({ body });
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "500");
  } else {
    docs.reply({ body: stored });
    await expect.poll(async () => (await mirror(page)).length).toBe(2);
  }
  const before = await settledViewport(page);
  await takeover?.();
  const taken = takeover ? await settledViewport(page) : null;
  if (order === "bars-first") docs.reply({ body: stored });
  else bars.reply({ body });
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "500");
  await expect.poll(async () => (await mirror(page)).length).toBe(2);
  return { before, taken, after: await settledViewport(page), drawings: await mirror(page), stored };
}

test("initial viewport projects saved points equally for either response order", async ({ page, scenario }) => {
  seed(scenario);
  await page.addInitScript(installChartProbe);
  const first = await controlledReload(page, scenario, "bars-first");
  const second = await controlledReload(page, scenario, "drawings-first");
  expect(second.drawings.map((item) => item.tool)).toEqual(["ray", "crossline"]);
  expect(second.after.width).toBe(first.after.width);
  expect(second.after.spacing).toBeCloseTo(first.after.spacing, 6);
  expect(second.after.range!.from).toBeCloseTo(first.after.range!.from, 6);
  expect(second.after.range!.to).toBeCloseTo(first.after.range!.to, 6);
  for (const item of first.drawings) {
    const again = second.drawings.find((drawing) => drawing.id === item.id)!;
    again.points.forEach((point, index) => {
      expect(point!.x).toBeCloseTo(item.points[index]!.x, 2);
      expect(point!.y).toBeCloseTo(item.points[index]!.y, 2);
    });
  }
  expect(await drawings(scenario)).toEqual(first.stored);
});

for (const action of ["pan", "vertical wheel", "horizontal wheel", "width resize"]) {
  test(`initial viewport yields to ${action} before delayed drawings`, async ({ page, scenario }) => {
    seed(scenario);
    await page.addInitScript(installChartProbe);
    const result = await controlledReload(page, scenario, "bars-first", async () => {
      const box = (await chartOf(cell(page)).boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6);
      if (action === "pan") {
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 10 });
        await page.mouse.up();
      } else if (action === "vertical wheel") await page.mouse.wheel(0, -120);
      else if (action === "horizontal wheel") await page.mouse.wheel(120, 0);
      else {
        const size = page.viewportSize()!;
        await page.setViewportSize({ width: size.width - 100, height: size.height });
      }
    });
    if (action !== "width resize") expect(result.taken!.range).not.toEqual(result.before.range);
    expect(result.taken!.locked).toBe(false);
    expect(result.after.locked).toBe(false);
    expect(result.after.spacing).toBeCloseTo(result.taken!.spacing, 6);
    expect(result.after.range!.to).toBeCloseTo(result.taken!.range!.to, 6);
  });
}
