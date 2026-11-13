import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

const KST = 9 * 3600;
const DAY = 86400;

async function drag(page: Page, from: [number, number], to: [number, number], shift = false) {
  const a = await chartPoint(page, ...from);
  const b = await chartPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

test("도형 도구: 사각형·타원·꺾은선·붓을 그리고 새로고침 뒤에도 같은 자리에 보인다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const count = async () => (await drawings(scenario)).length;

  await cell(page).focus();
  await page.keyboard.press("R");
  await drag(page, [0.12, 0.25], [0.22, 0.4]);
  await expect.poll(count).toBe(1);
  expect((await drawings(scenario))[0]!.tool).toBe("rect");

  await cell(page).focus();
  await page.keyboard.press("R");
  await drag(page, [0.28, 0.25], [0.4, 0.33], true);
  await expect.poll(count).toBe(2);
  const squareId = (await drawings(scenario))[1]!.id;
  const square = (await mirror(page)).find((d) => d.id === squareId)!;
  const [a, b] = square.points;
  expect(Math.abs(Math.abs(b!.x - a!.x) - Math.abs(b!.y - a!.y))).toBeLessThan(1);
  expect(Math.abs(b!.x - a!.x)).toBeGreaterThan(20);

  await pickTool(page, "도형", "타원");
  await drag(page, [0.46, 0.25], [0.58, 0.4]);
  await expect.poll(count).toBe(3);
  expect((await drawings(scenario))[2]!.tool).toBe("ellipse");

  await pickTool(page, "도형", "꺾은선");
  const vertices = await Promise.all(([[0.12, 0.6], [0.2, 0.75], [0.28, 0.6], [0.36, 0.75]] as const).map(([x, y]) => chartPoint(page, x, y)));
  for (const v of vertices) await page.mouse.click(v.x, v.y);
  const last = vertices.at(-1)!;
  await page.mouse.dblclick(last.x, last.y);
  await expect.poll(count).toBe(4);
  const polyline = (await drawings(scenario))[3]!;
  expect(polyline.tool).toBe("path");
  expect(polyline.points).toHaveLength(4);

  await expect(page.getByRole("button", { name: "자석", exact: true })).toHaveAttribute("aria-pressed", "true");
  await pickTool(page, "도형", "붓");
  const trail = await Promise.all(([[0.46, 0.6], [0.52, 0.72], [0.58, 0.58], [0.64, 0.74], [0.7, 0.62]] as const).map(([x, y]) => chartPoint(page, x, y)));
  await page.mouse.move(trail[0]!.x, trail[0]!.y);
  await page.mouse.down();
  for (const p of trail.slice(1)) await page.mouse.move(p.x, p.y, { steps: 40 });
  await page.mouse.up();
  await expect.poll(count).toBe(5);
  const stroke = (await drawings(scenario))[4]!;
  expect(stroke.tool).toBe("brush");
  expect(stroke.points.length).toBeGreaterThan(20);
  expect(stroke.points.length).toBeLessThanOrEqual(1000);
  const offBarStart = stroke.points.filter((p) => (p.t + KST) % DAY !== 0).length;
  expect(offBarStart / stroke.points.length).toBeGreaterThan(0.5);

  const before = await mirror(page);
  expect(before.map((d) => d.tool).sort()).toEqual(["brush", "ellipse", "path", "rect", "rect"]);
  const saved = await drawings(scenario);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(5);
  expect(await drawings(scenario)).toEqual(saved);
  const after = await mirror(page);
  for (const d of before) {
    const again = after.find((x) => x.id === d.id)!;
    expect(again.points).toHaveLength(d.points.length);
    d.points.forEach((p, i) => {
      expect(again.points[i]!.x).toBeCloseTo(p!.x, 0);
      expect(again.points[i]!.y).toBeCloseTo(p!.y, 0);
    });
  }
  expect(errors).toEqual([]);
});

test("꺾은선: 두 번 누르는 사이 마우스가 1px 움직여도 꼭짓점을 더하지 않는다", async ({ page, scenario }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "자석", exact: true })).toHaveAttribute("aria-pressed", "true");
  const [a, b, c] = await Promise.all(([[0.2, 0.6], [0.3, 0.75], [0.4, 0.6]] as const).map(([x, y]) => chartPoint(page, x, y)));
  const counts: number[] = [];
  for (let i = 0; i < 12; i++) {
    await pickTool(page, "도형", "꺾은선");
    const x = Math.round(c!.x) + i;
    await page.mouse.click(a!.x, a!.y);
    await page.mouse.click(b!.x, b!.y);
    await page.mouse.click(x, c!.y);
    await page.mouse.click(x + 1, c!.y, { clickCount: 2 });
    await expect.poll(async () => (await drawings(scenario)).length).toBe(i + 1);
    counts.push((await drawings(scenario))[i]!.points.length);
  }
  expect(counts).toEqual(Array.from({ length: 12 }, () => 3));
});
