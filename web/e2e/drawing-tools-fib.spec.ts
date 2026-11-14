import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

async function settledMirror(page: Page) {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await mirror(page));
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return mirror(page);
}

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

  await expect(page.getByRole("navigation", { name: "드로잉 도구" }).getByRole("button", { name: "피보나치·갠 도구 펼치기", exact: true })).toBeVisible();
  await pickTool(page, "피보나치·갠", "피보나치 확장");
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

test("피보나치 팬·시간대와 갠 팬·상자를 놓고, 핸들을 끌고, 수준을 끄고, 새로고침 뒤에도 같은 자리에 보인다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const r = (await chartOf(cell(page)).boundingBox())!;
  const savedOf = async (tool: string) => (await drawings(scenario)).find((d) => d.tool === tool)!;
  const place = async (label: string, tool: string, spots: readonly (readonly [number, number])[]) => {
    await pickTool(page, "피보나치·갠", label);
    await clickAt(page, spots);
    await expect.poll(async () => (await drawings(scenario)).filter((d) => d.tool === tool).map((d) => d.points.length)).toEqual([2]);
    const placed = await savedOf(tool);
    await expect.poll(async () => (await mirror(page)).find((d) => d.id === placed.id)?.selected).toBe(true);
    return placed;
  };
  const drag = async (id: string, index: number, dx: number, dy: number) => {
    const h = (await mirror(page)).find((d) => d.id === id)!.handles[index]!;
    await page.mouse.move(r.x + h.x, r.y + h.y);
    await page.mouse.down();
    await page.mouse.move(r.x + h.x + dx, r.y + h.y + dy, { steps: 10 });
    await page.mouse.up();
  };

  const fan = await place("피보나치 팬", "fibfan", [[0.08, 0.75], [0.22, 0.45]]);
  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "피보나치 팬 세부 설정" });
  await dialog.getByRole("checkbox", { name: "수준 2 켜기", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  const fanLevels = async () => ((await savedOf("fibfan")).style as { levels: { value: number; on: boolean }[] }).levels;
  await expect.poll(async () => (await fanLevels()).map((l) => [l.value, l.on])).toEqual([[0, true], [0.25, false], [0.382, true], [0.5, true], [0.618, true], [0.75, true], [1, true]]);
  expect((await savedOf("fibfan")).points).toEqual(fan.points);

  const time = await place("피보나치 시간대", "fibtime", [[0.3, 0.3], [0.34, 0.35]]);
  await expect.poll(async () => (await mirror(page)).find((d) => d.id === time.id)?.handles.length).toBe(2);
  await drag(time.id, 1, 40, 60);
  await expect.poll(async () => (await savedOf("fibtime")).points[1]!.t).toBeGreaterThan(time.points[1]!.t);
  const timeMoved = (await savedOf("fibtime")).points;
  expect(timeMoved[0]).toEqual(time.points[0]);
  expect(timeMoved[1]!.price).toBe(time.points[1]!.price);

  await place("갠 팬", "gannfan", [[0.45, 0.62], [0.52, 0.5]]);

  const box = await place("갠 상자", "gannbox", [[0.65, 0.25], [0.8, 0.5]]);
  await expect.poll(async () => (await mirror(page)).find((d) => d.id === box.id)?.handles.length).toBe(4);
  await drag(box.id, 2, 40, -50);
  await expect.poll(async () => (await savedOf("gannbox")).points).not.toEqual(box.points);
  const [boxStart, boxEnd] = (await savedOf("gannbox")).points;
  expect(boxStart!.t).toBe(box.points[0]!.t);
  expect(boxStart!.price).toBeGreaterThan(box.points[0]!.price);
  expect(boxEnd!.t).toBeGreaterThan(box.points[1]!.t);
  expect(boxEnd!.price).toBe(box.points[1]!.price);

  await page.keyboard.press("Escape");
  await expect.poll(async () => (await mirror(page)).some((d) => d.selected)).toBe(false);
  const before = await settledMirror(page);
  expect(before.map((d) => d.tool).sort()).toEqual(["fibfan", "fibtime", "gannbox", "gannfan"]);
  await page.screenshot({ path: testInfo.outputPath("fib-gann.png") });
  const saved = await drawings(scenario);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(4);
  expect(await drawings(scenario)).toEqual(saved);
  const drift = async () => (await mirror(page)).flatMap((d) => d.points.map((p, i) => {
    const was = before.find((x) => x.id === d.id)!.points[i]!;
    return p === null ? Infinity : Math.max(Math.abs(p.x - was.x), Math.abs(p.y - was.y));
  }));
  await expect.poll(async () => Math.max(...(await drift()))).toBeLessThan(1);
  expect(errors).toEqual([]);
});
