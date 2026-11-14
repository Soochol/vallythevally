import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

type At = readonly [number, number];

const zigzag = (left: number, width: number, top: number, bottom: number, count: number, startHigh = false): At[] =>
  Array.from({ length: count }, (_, i) => [left + (width * i) / (count - 1), (i % 2 === 0) !== startHigh ? bottom : top] as const);

const PATTERNS: readonly { label: string; tool: string; spots: readonly At[] }[] = [
  { label: "엘리엇 충격 파동", tool: "elliott", spots: zigzag(0.06, 0.3, 0.22, 0.36, 6) },
  { label: "엘리엇 조정 파동", tool: "elliottabc", spots: zigzag(0.5, 0.3, 0.22, 0.36, 4, true) },
  { label: "XABCD 패턴", tool: "xabcd", spots: [[0.06, 0.58], [0.12, 0.44], [0.18, 0.54], [0.24, 0.47], [0.3, 0.62]] },
  { label: "헤드앤숄더", tool: "headshoulders", spots: [[0.42, 0.64], [0.48, 0.52], [0.54, 0.58], [0.6, 0.44], [0.66, 0.58], [0.72, 0.52], [0.78, 0.64]] },
];

async function clickAt(page: Page, spots: readonly At[]) {
  for (const spot of spots) {
    const p = await chartPoint(page, ...spot);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.click(p.x, p.y);
  }
}

test("패턴 도구: 네 도구를 골라 점을 다 찍으면 저장되고, 머리 핸들을 끌면 넷째 점이 바뀌고, 새로고침 뒤에도 같은 자리에 보인다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  await expect(bar.getByRole("button", { name: "패턴 도구 펼치기", exact: true })).toBeVisible();

  await pickTool(page, "패턴", "엘리엇 충격 파동");
  await clickAt(page, PATTERNS[0]!.spots.slice(0, 3));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await drawings(scenario)).toEqual([]);
  expect(await mirror(page)).toEqual([]);

  for (const [index, pattern] of PATTERNS.entries()) {
    await pickTool(page, "패턴", pattern.label);
    await clickAt(page, pattern.spots.slice(0, -1));
    expect(await drawings(scenario), pattern.label).toHaveLength(index);
    await clickAt(page, pattern.spots.slice(-1));
    await expect.poll(async () => (await drawings(scenario)).length, { message: pattern.label }).toBe(index + 1);
    const saved = (await drawings(scenario))[index]!;
    expect(saved.tool, pattern.label).toBe(pattern.tool);
    expect(saved.points, pattern.label).toHaveLength(pattern.spots.length);
  }

  const placed = (await drawings(scenario))[3]!;
  await expect.poll(async () => (await mirror(page)).find((d) => d.id === placed.id)?.handles.length).toBe(7);
  const r = (await chartOf(cell(page)).boundingBox())!;
  const head = (await mirror(page)).find((d) => d.id === placed.id)!.handles[3]!;
  await page.mouse.move(r.x + head.x, r.y + head.y);
  await page.mouse.down();
  await page.mouse.move(r.x + head.x + 10, r.y + head.y - 50, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await drawings(scenario))[3]!.points[3]).not.toEqual(placed.points[3]);
  const moved = (await drawings(scenario))[3]!.points;
  expect(moved[3]!.price).toBeGreaterThan(placed.points[3]!.price);
  expect([...moved.slice(0, 3), ...moved.slice(4)]).toEqual([...placed.points.slice(0, 3), ...placed.points.slice(4)]);

  const before = await mirror(page);
  expect(before.map((d) => d.tool).sort()).toEqual(PATTERNS.map((p) => p.tool).sort());
  const saved = await drawings(scenario);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(PATTERNS.length);
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
  await page.screenshot({ path: testInfo.outputPath("patterns.png") });
  expect(errors).toEqual([]);
});
