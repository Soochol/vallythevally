import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import { test, expect, cell, chartOf, type App } from "./harness";

interface Mirror {
  id: string;
  selected: boolean;
  points: ({ x: number; y: number } | null)[];
  handles: { x: number; y: number }[];
}

async function mirror(page: Page): Promise<Mirror[]> {
  return JSON.parse(await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]");
}

const drawings = async (app: App): Promise<Drawing[]> => (await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`)).json();

for (const history of ["loaded", "older"] as const) {
  test(`hline body drag changes price and preserves its ${history} timestamp`, async ({ page, app }, testInfo) => {
    await page.goto("/");
    const chart = chartOf(cell(page));
    await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    const box = await chart.boundingBox();
    if (box === null) throw new Error("차트가 보이지 않습니다");
    await cell(page).focus();
    await page.keyboard.press("G");
    await page.keyboard.press("H");
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await expect.poll(async () => (await drawings(app)).length).toBe(1);
    const saved = (await drawings(app))[0]!;
    const point = saved.points[0]!;
    const first = Number(await chart.getAttribute("data-first-bar-t"));
    const timestamp = history === "older" ? first - 86400 : point.t;
    const response = await fetch(`${app.url}/api/drawings/${saved.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...saved, points: [{ ...point, t: timestamp }], revision: saved.revision + 100 }),
    });
    expect(response.status).toBe(200);
    await page.reload();
    await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    await expect.poll(async () => (await mirror(page)).length).toBe(1);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await expect.poll(async () => (await mirror(page))[0]?.handles.length).toBe(1);
    const before = (await mirror(page))[0]!;
    expect(before.selected).toBe(true);
    if (history === "older") expect(before.points).toEqual([null]);
    const handle = before.handles[0]!;
    const x = box.width * 0.7;
    expect(Math.abs(x - handle.x)).toBeGreaterThan(20);
    await page.mouse.move(box.x + x, box.y + handle.y);
    await page.mouse.down();
    await page.mouse.move(box.x + x, box.y + handle.y + 70, { steps: 12 });
    await page.mouse.up();
    await page.screenshot({ path: testInfo.outputPath("after-body-drag.png") });
    await expect.poll(async () => (await drawings(app))[0]?.points[0]?.price).not.toBe(point.price);
    expect((await drawings(app))[0]!.points[0]!.t).toBe(timestamp);
    await expect.poll(async () => (await mirror(page))[0]?.handles[0]?.y).toBeCloseTo(handle.y + 70, 0);
  });
}
