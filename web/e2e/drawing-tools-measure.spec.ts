import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

async function dragBetween(page: Page, from: [number, number], to: [number, number]) {
  const a = await chartPoint(page, ...from);
  const b = await chartPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

async function clickAt(page: Page, at: [number, number]) {
  const p = await chartPoint(page, ...at);
  await page.mouse.click(p.x, p.y);
}

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

async function savedOf(scenario: Scenario, tool: string) {
  const found = (await drawings(scenario)).filter((d) => d.tool === tool);
  expect(found).toHaveLength(1);
  return found[0]!;
}

test("측정 그룹 네 도구를 골라 놓고, 포지션 목표가 핸들을 끌고, 새로고침 뒤에도 보인다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  await expect(bar.getByRole("button", { name: "측정 도구 펼치기", exact: true })).toBeVisible();

  await pickTool(page, "측정", "가격 범위");
  await dragBetween(page, [0.55, 0.3], [0.62, 0.45]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);

  await pickTool(page, "측정", "날짜 범위");
  await dragBetween(page, [0.66, 0.6], [0.74, 0.7]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(2);

  await pickTool(page, "측정", "매도 포지션");
  await clickAt(page, [0.3, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(3);

  await pickTool(page, "측정", "매수 포지션");
  await clickAt(page, [0.45, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(4);

  expect((await savedOf(scenario, "pricerange")).points).toHaveLength(2);
  expect((await savedOf(scenario, "daterange")).points).toHaveLength(2);
  const [shortEntry, shortTarget, shortStop] = (await savedOf(scenario, "short")).points;
  expect(shortTarget!.price).toBeLessThan(shortEntry!.price);
  expect(shortStop!.price).toBeGreaterThan(shortEntry!.price);
  const placed = await savedOf(scenario, "long");
  expect(placed.points).toHaveLength(3);
  const [entry, target, stop] = placed.points;
  expect(target!.price).toBeGreaterThan(entry!.price);
  expect(stop!.price).toBeLessThan(entry!.price);
  expect(target!.t).toBeGreaterThan(entry!.t);

  const longMirror = (await mirror(page)).find((m) => m.id === placed.id)!;
  expect(longMirror.selected).toBe(true);
  const handle = longMirror.handles[0]!;
  const r = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.move(r.x + handle.x, r.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(r.x + handle.x, r.y + handle.y - 40, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await savedOf(scenario, "long")).points[1]!.price).toBeGreaterThan(target!.price);
  const dragged = await savedOf(scenario, "long");
  expect(dragged.points[0]).toEqual(entry);
  expect(dragged.points[2]).toEqual(stop);

  await cell(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await mirror(page)).some((m) => m.selected)).toBe(false);
  const before = await drawings(scenario);
  const screens = new Map((await settledMirror(page)).map((m) => [m.id, m.points]));
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(4);
  expect(await drawings(scenario)).toEqual(before);
  const drift = async () => (await mirror(page)).flatMap((m) => m.points.map((p, i) => {
    const was = screens.get(m.id)![i]!;
    return p === null ? Infinity : Math.max(Math.abs(p.x - was.x), Math.abs(p.y - was.y));
  }));
  await expect.poll(async () => Math.max(...(await drift()))).toBeLessThan(1);
  expect(errors).toEqual([]);
});
