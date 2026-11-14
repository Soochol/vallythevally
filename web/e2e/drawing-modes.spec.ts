import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { bodyAlong, chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

type Point = { x: number; y: number };

async function drag(page: Page, from: Point, to: Point, steps = 16) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function trendline(page: Page, from: [number, number], to: [number, number]) {
  await cell(page).focus();
  await page.keyboard.press("T");
  await drag(page, await chartPoint(page, ...from), await chartPoint(page, ...to));
}

async function middleOf(page: Page, id: string): Promise<Point> {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const [a, b] = (await mirror(page)).find((d) => d.id === id)?.points ?? [];
  if (!a || !b) throw new Error(`${id} 드로잉의 두 점이 화면에 없습니다`);
  return { x: box.x + (a.x + b.x) / 2, y: box.y + (a.y + b.y) / 2 };
}

const eraserButton = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" }).getByRole("button", { name: "지우개", exact: true });

async function pickEraser(page: Page) {
  await eraserButton(page).click();
  await expect(eraserButton(page)).toHaveAttribute("aria-pressed", "true");
}

test("지우개: 클릭·끌기·Ctrl+끌기로 지우고, 잠긴 드로잉은 남기며, Ctrl+Z 한 번으로 돌아온다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const ids = async () => (await drawings(scenario)).map((d) => d.id).sort();

  await trendline(page, [0.15, 0.35], [0.3, 0.25]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);
  await trendline(page, [0.45, 0.35], [0.6, 0.25]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(2);
  const [first, second] = (await drawings(scenario)).map((d) => d.id);
  if (!first || !second) throw new Error("추세선 둘이 저장되지 않았습니다");
  const both = await ids();

  await expect(eraserButton(page)).toHaveAttribute("aria-pressed", "false");
  await pickEraser(page);
  await expect(page.getByRole("button", { name: "선택 도구", exact: true })).toHaveAttribute("aria-pressed", "false");
  const firstMiddle = await middleOf(page, first);
  await page.mouse.click(firstMiddle.x, firstMiddle.y);
  await expect.poll(ids).toEqual([second]);
  await expect(eraserButton(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+z");
  await expect.poll(ids).toEqual(both);

  await pickEraser(page);
  await drag(page, await middleOf(page, first), await middleOf(page, second), 30);
  await expect.poll(ids).toEqual([]);
  await page.keyboard.press("Control+z");
  await expect.poll(ids).toEqual(both);

  const box = (await chartOf(cell(page)).boundingBox())!;
  const target = await middleOf(page, first);
  await page.mouse.click(target.x, target.y);
  await page.getByRole("toolbar", { name: "드로잉 스타일" }).getByRole("button", { name: "잠금", exact: true }).click();
  await expect.poll(async () => (await drawings(scenario)).find((d) => d.id === first)?.locked).toBe(true);
  await pickEraser(page);
  await page.mouse.click(target.x, target.y);
  await pickEraser(page);
  await drag(page, await middleOf(page, first), await middleOf(page, second), 30);
  await expect.poll(ids).toEqual([first]);
  await expect(eraserButton(page)).toHaveAttribute("aria-pressed", "false");

  await pickTool(page, "도형", "붓");
  await drag(page, await chartPoint(page, 0.2, 0.7), await chartPoint(page, 0.6, 0.7), 60);
  await expect.poll(async () => (await drawings(scenario)).filter((d) => d.tool === "brush").length).toBe(1);
  const [stroke] = (await drawings(scenario)).filter((d) => d.tool === "brush");
  if (!stroke) throw new Error("붓 획이 저장되지 않았습니다");
  await pickEraser(page);
  await page.keyboard.down("Control");
  await drag(page, await chartPoint(page, 0.4, 0.6), await chartPoint(page, 0.4, 0.8));
  await page.keyboard.up("Control");
  await expect.poll(async () => (await drawings(scenario)).filter((d) => d.tool === "brush").length).toBe(2);
  const pieces = (await drawings(scenario)).filter((d) => d.tool === "brush");
  expect(pieces.map((d) => d.id)).toContain(stroke.id);
  expect(pieces.reduce((n, d) => n + d.points.length, 0)).toBeLessThan(stroke.points.length);
  for (const piece of pieces) expect({ style: piece.style, scope: piece.scope, group: piece.group, periods: piece.periods }).toEqual({ style: stroke.style, scope: stroke.scope, group: stroke.group, periods: stroke.periods });

  const saved = await drawings(scenario);
  const before = await mirror(page);
  await page.keyboard.down("Alt");
  await drag(page, { x: box.x + box.width * 0.65, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.85, y: box.y + box.height * 0.55 });
  await page.keyboard.up("Alt");
  expect((await mirror(page)).map((d) => d.points)).toEqual(before.map((d) => d.points));
  await expect.poll(async () => drawings(scenario)).toEqual(saved);

  await page.getByRole("button", { name: "드로잉 단축키 도움말", exact: true }).click();
  const help = page.getByRole("dialog", { name: "드로잉 단축키" });
  await expect(help).toContainText("시연 커서");
  await expect(help).toContainText("붓 획 일부 지우기");
  expect(errors).toEqual([]);
});

async function bodyOf(page: Page, id: string): Promise<Point> {
  const box = (await chartOf(cell(page)).boundingBox())!;
  const points = (await mirror(page)).find((d) => d.id === id)!.points.map((p) => ({ x: box.x + p!.x, y: box.y + p!.y }));
  const [a, b, c] = points;
  const segments = points.slice(1).map((p, i) => [points[i]!, p] as const);
  if (a && b && c) segments.push([a, { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }]);
  return bodyAlong(page, segments);
}

test("지우개: 선, 피보나치·갠, 패턴, 측정 그룹의 새 도구도 눌러 지운다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const spots: [number, number][] = [[0.3, 0.6], [0.4, 0.35], [0.5, 0.55], [0.6, 0.3], [0.7, 0.6], [0.8, 0.4], [0.85, 0.55]];
  for (const [group, label, clicks] of [["선", "피치포크", 3], ["피보나치·갠", "갠 상자", 2], ["패턴", "헤드앤숄더", 7], ["측정", "날짜·가격 범위", 2]] as const) {
    await pickTool(page, group, label);
    for (const spot of spots.slice(0, clicks)) {
      const p = await chartPoint(page, ...spot);
      await page.mouse.click(p.x, p.y);
    }
    await expect.poll(async () => (await drawings(scenario)).length, { message: label }).toBe(1);
    await page.keyboard.press("Escape");
    const [placed] = await drawings(scenario);
    const target = await bodyOf(page, placed!.id);
    await pickEraser(page);
    await page.mouse.click(target.x, target.y);
    await expect.poll(async () => (await drawings(scenario)).length, { message: `지우개로 ${label}` }).toBe(0);
    await expect.poll(async () => (await mirror(page)).length).toBe(0);
  }
  expect(errors).toEqual([]);
});
