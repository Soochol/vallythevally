import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import { cell, chartOf, expect, test } from "./harness";

const START = Date.parse("2025-01-01T00:00:00+09:00") / 1000;
const MARKERS = [400, 450].map((index, z): DrawingInput => ({
  id: `01900000-0000-7000-8000-00000000018${z}`,
  symbol: "IDX:001", tool: "trendline", points: [
    { t: START + index * 86400, price: 4980 }, { t: START + index * 86400, price: 5020 },
  ],
  text: null, style: {}, locked: false, hidden: false, periods: null, z, group: null,
  scope: { kind: "symbol" }, revision: 1,
}));

async function positions(page: Page): Promise<number[]> {
  const rows: unknown = JSON.parse(await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]");
  if (!Array.isArray(rows)) throw new Error("드로잉 위치가 없습니다");
  return rows.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("points" in row) || !Array.isArray(row.points)) throw new Error("드로잉 점이 없습니다");
    const point: unknown = row.points[0];
    if (typeof point !== "object" || point === null || !("x" in point) || typeof point.x !== "number") throw new Error("드로잉 가로 위치가 없습니다");
    return point.x;
  });
}

async function wheel(page: Page, deltaX: number, deltaY: number, key?: "Shift" | "Control" | "Meta") {
  if (key) await page.keyboard.down(key);
  const delivered = page.evaluate(() => new Promise<void>((resolve) => {
    document.addEventListener("wheel", () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { once: true, capture: true });
  }));
  await page.mouse.wheel(deltaX, deltaY);
  await delivered;
  if (key) await page.keyboard.up(key);
}

test.beforeEach(async ({ page, scenario }) => {
  const bars: Bar[] = Array.from({ length: 500 }, (_, index) => ({
    t: START + index * 86400, o: 5000, h: 5020, l: 4980, c: 5000, v: 1000,
  }));
  await page.route("**/api/bars?**", (route) => route.fulfill({ json: {
    symbol: "IDX:001", venue: null, period: "D", bars, current: null, nextBefore: null, seq: null,
  } }));
  for (const marker of MARKERS) {
    scenario.documents.saveDrawing(marker);

  }
  await page.goto("/");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "500");
  await expect.poll(async () => (await positions(page)).length).toBe(2);
});

test("일반 휠은 오른쪽을 기준으로 확대·축소한다", async ({ page }) => {
  const chart = chartOf(cell(page));
  const box = (await chart.boundingBox())!;
  const before = await positions(page);
  await page.mouse.move(box.x + before[0]!, box.y + box.height * 0.6);
  await wheel(page, 0, -100);
  const after = await positions(page);
  const ratio = (after[1]! - after[0]!) / (before[1]! - before[0]!);
  expect(ratio).toBeGreaterThan(1.05);
  expect(after[0]).toBeLessThan(before[0]! - 10);
  const fixedX = (after[0]! - ratio * before[0]!) / (1 - ratio);
  expect(fixedX).toBeGreaterThan(box.width * 0.9);
  expect(fixedX).toBeLessThan(box.width);
  await wheel(page, 0, 100);
  expect((await positions(page))[1]! - (await positions(page))[0]!).toBeLessThan(after[1]! - after[0]!);
});

for (const key of ["Control", "Meta"] as const) {
  test(`${key}+휠은 포인터 아래 봉의 위치를 유지하며 확대한다`, async ({ page }) => {
    const box = (await chartOf(cell(page)).boundingBox())!;
    const before = await positions(page);
    const width = await page.evaluate(() => innerWidth);
    await page.mouse.move(box.x + before[0]!, box.y + box.height * 0.6);
    await wheel(page, 0, -100, key);
    const after = await positions(page);
    expect(after[0]).toBeCloseTo(before[0]!, 0);
    expect(after[1]! - after[0]!).toBeGreaterThan((before[1]! - before[0]!) * 1.05);
    expect(await page.evaluate(() => innerWidth)).toBe(width);
    await wheel(page, 0, -100);
    expect((await positions(page))[0]).toBeLessThan(after[0]! - 10);
  });
}

test("Shift+휠은 봉 간격을 유지하며 과거와 미래로 이동한다", async ({ page }) => {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const before = await positions(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  await wheel(page, 0, -100, "Shift");
  const past = await positions(page);
  expect(past[0]).toBeGreaterThan(before[0]! + 10);
  expect(past[1]! - past[0]!).toBeCloseTo(before[1]! - before[0]!, 2);
  await wheel(page, 0, 100, "Shift");
  const returned = await positions(page);
  expect(returned[0]).toBeCloseTo(before[0]!, 1);
  expect(returned[1]).toBeCloseTo(before[1]!, 1);
});

test("가로 휠은 봉 간격을 유지하며 이동한다", async ({ page }) => {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const before = await positions(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  await wheel(page, 100, 0);
  const after = await positions(page);
  expect(after[0]).toBeLessThan(before[0]! - 10);
  expect(after[1]! - after[0]!).toBeCloseTo(before[1]! - before[0]!, 2);
});

test("드로잉을 잡고 있는 동안 휠로 차트가 이동하거나 확대되지 않는다", async ({ page }) => {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const before = await positions(page);
  await page.mouse.move(box.x + before[0]!, box.y + box.height * 0.4);
  await page.mouse.down();
  try {
    for (const key of [undefined, "Shift", "Control"] as const) {
      await wheel(page, 0, -100, key);
      expect(await positions(page)).toEqual(before);
    }
  } finally {
    await page.mouse.up();
  }
  await wheel(page, 0, -100, "Shift");
  expect((await positions(page))[0]).toBeGreaterThan(before[0]! + 10);
});
