import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { chartPoint, mirror, open } from "./drawing-probe";

test.use({ clockStart: "20261109100000" });

async function frames(page: Page, count: number) {
  await page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function ready(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await mirror(page)).length).toBe(0);
  const start = await chartPoint(page, 0.1, 0.9);
  await page.mouse.move(start.x, start.y);
  await frames(page, 60);
}

async function countRebuilds(page: Page) {
  await chartOf(cell(page)).locator(".drawing-mirror").evaluate((element) => {
    const counter = window as unknown as { drawingRebuilds: number };
    counter.drawingRebuilds = 0;
    new MutationObserver((records) => { counter.drawingRebuilds += records.length; }).observe(element, { attributes: true, attributeFilter: ["data-drawings"] });
  });
}

const rebuilds = (page: Page) => page.evaluate(() => (window as unknown as { drawingRebuilds: number }).drawingRebuilds);

async function sweep(page: Page) {
  for (let i = 0; i < 20; i++) {
    const at = await chartPoint(page, 0.1 + i * 0.01, 0.9 - (i % 2) * 0.01);
    await page.mouse.move(at.x, at.y);
    await frames(page, 1);
  }
  await frames(page, 3);
}

test("도구 없이 마우스만 움직이면 드로잉을 다시 계산하지 않는다", async ({ page }) => {
  await ready(page);
  await countRebuilds(page);
  await sweep(page);
  expect(await rebuilds(page)).toBe(0);
});

test("고른 도구가 시작 전이면 마우스만 움직여도 드로잉을 다시 계산하지 않는다", async ({ page }) => {
  await ready(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  await frames(page, 10);
  await countRebuilds(page);
  await sweep(page);
  expect(await rebuilds(page)).toBe(0);
  expect(await chartOf(cell(page)).evaluate((element) => element.style.cursor)).toBe("crosshair");
});
