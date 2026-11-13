import type { Drawing } from "../src/api/generated/Drawing";
import {  cell, expect, test } from "./harness";

for (const outside of ["거래량 영역", "가격축"] as const) {
  test(`차트 우클릭 메뉴는 ${outside}의 닫기 클릭을 소비하고 차트로 포커스를 돌린다`, async ({ page, scenario }) => {
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const box = await cell(page).boundingBox();
    if (!box) throw new Error("차트 영역이 없습니다");
    const drawings = async (): Promise<Drawing[]> => scenario.documents.drawings("005930");
    await cell(page).focus(); await page.keyboard.press("H");
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2, { button: "right" });
    const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
    await expect(menu).toBeVisible();
    const point = outside === "거래량 영역"
      ? { x: box.x + box.width * 0.8, y: box.y + box.height * 0.85 }
      : { x: box.x + box.width - 12, y: box.y + box.height * 0.3 };
    const canvasWidth = await page.evaluate(({ x, y }) => {
      const canvas = document.elementFromPoint(x, y);
      return canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect().width : 0;
    }, point);
    if (outside === "가격축") { expect(canvasWidth).toBeGreaterThan(0); expect(canvasWidth).toBeLessThan(100); }
    else expect(canvasWidth).toBeGreaterThan(box.width / 2);
    await page.mouse.click(point.x, point.y);
    await expect(menu).toBeHidden(); await expect(cell(page)).toBeFocused();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(cell(page).locator("[data-drawings]")).toHaveAttribute("data-drawings", "[]");
    expect(await drawings()).toEqual([]);
    await page.keyboard.press("W");
    await expect(cell(page)).toHaveAttribute("aria-label", /주$/);
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(cell(page).locator("[data-drawings]")).toHaveAttribute("data-drawings", "[]");
    expect(await drawings()).toEqual([]);
  });
}
