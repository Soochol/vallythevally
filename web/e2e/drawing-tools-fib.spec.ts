import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

async function clickAt(page: Page, spots: readonly (readonly [number, number])[]) {
  for (const [fx, fy] of spots) {
    const p = await chartPoint(page, fx, fy);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.click(p.x, p.y);
  }
}

test("피보나치 되돌림과 확장을 놓고, 수준을 끄고, 새로고침 뒤에도 같은 자리에 보인다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  await cell(page).focus();
  await page.keyboard.press("F");
  await clickAt(page, [[0.2, 0.3], [0.4, 0.6]]);
  await expect.poll(async () => (await drawings(scenario)).map((d) => [d.tool, d.points.length])).toEqual([["fib", 2]]);

  await expect(page.getByRole("navigation", { name: "드로잉 도구" }).getByRole("button", { name: "피보나치 도구 펼치기", exact: true })).toBeVisible();
  await pickTool(page, "피보나치", "피보나치 확장");
  await clickAt(page, [[0.55, 0.65], [0.7, 0.3], [0.82, 0.5]]);
  await expect.poll(async () => (await drawings(scenario)).map((d) => [d.tool, d.points.length]).sort()).toEqual([["fib", 2], ["fibext", 3]]);
  const ext = (await drawings(scenario)).find((d) => d.tool === "fibext")!;
  await expect.poll(async () => (await mirror(page)).find((d) => d.id === ext.id)?.selected).toBe(true);

  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "피보나치 확장 세부 설정" });
  await dialog.getByRole("checkbox", { name: "수준 2 켜기", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  const levels = async () => ((await drawings(scenario)).find((d) => d.id === ext.id)?.style as { levels: { value: number; on: boolean }[] }).levels;
  await expect.poll(async () => (await levels()).map((l) => [l.value, l.on])).toEqual([[0, true], [0.618, false], [1, true], [1.272, true], [1.618, true], [2.618, false]]);

  await page.keyboard.press("Escape");
  await expect.poll(async () => (await mirror(page)).some((d) => d.selected)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("fib.png") });
  const before = await mirror(page);
  const saved = await drawings(scenario);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(2);
  const after = await mirror(page);
  for (const d of before) {
    const restored = after.find((x) => x.id === d.id)!;
    restored.points.forEach((p, i) => {
      expect(p!.x).toBeCloseTo(d.points[i]!.x, 0);
      expect(p!.y).toBeCloseTo(d.points[i]!.y, 0);
    });
  }
  expect(await drawings(scenario)).toEqual(saved);
  expect(errors).toEqual([]);
});
