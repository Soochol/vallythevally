import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test, pollSaved } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

type At = readonly [number, number];

const LINE_TOOLS: readonly { label: string; tool: string; clicks: readonly At[] }[] = [
  { label: "반직선", tool: "ray", clicks: [[0.3, 0.55], [0.4, 0.45]] },
  { label: "연장선", tool: "extline", clicks: [[0.45, 0.6], [0.55, 0.5]] },
  { label: "수평 반직선", tool: "hray", clicks: [[0.35, 0.3]] },
  { label: "수직선", tool: "vline", clicks: [[0.65, 0.4]] },
  { label: "십자선", tool: "crossline", clicks: [[0.75, 0.25]] },
  { label: "평행 채널", tool: "channel", clicks: [[0.2, 0.7], [0.4, 0.62], [0.3, 0.5]] },
  { label: "회귀 채널", tool: "regression", clicks: [[0.25, 0.5], [0.55, 0.5]] },
  { label: "피치포크", tool: "pitchfork", clicks: [[0.15, 0.45], [0.35, 0.3], [0.35, 0.6]] },
];

async function dragHandle(page: Page, index: number, dx: number, dy: number) {
  const r = (await chartOf(cell(page)).boundingBox())!;
  const h = (await mirror(page))[0]!.handles[index]!;
  await page.mouse.move(r.x + h.x, r.y + h.y);
  await page.mouse.down();
  await page.mouse.move(r.x + h.x + dx, r.y + h.y + dy, { steps: 10 });
  await page.mouse.up();
}

const clicksOf = (tool: string) => LINE_TOOLS.find((t) => t.tool === tool)!.clicks;

async function clickAll(page: Page, clicks: readonly At[]) {
  for (const [fx, fy] of clicks) {
    const p = await chartPoint(page, fx, fy);
    await page.mouse.click(p.x, p.y);
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("line tools: three clicks place a parallel channel and its handles change the saved points", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  await pickTool(page, "선", "평행 채널");
  const [first, second, third] = clicksOf("channel");
  await clickAll(page, [first!]);
  await clickAll(page, [second!]);
  expect(await drawings(scenario)).toHaveLength(0);
  await clickAll(page, [third!]);
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  const placed = (await drawings(scenario))[0]!;
  expect(placed).toMatchObject({ tool: "channel" });
  expect(placed.points).toHaveLength(3);
  await expect.poll(async () => (await mirror(page))[0]?.handles.length).toBe(3);
  await dragHandle(page, 2, 0, -40);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[2]).not.toEqual(placed.points[2]);
  const widened = (await drawings(scenario))[0]!.points;
  expect(widened.slice(0, 2)).toEqual(placed.points.slice(0, 2));
  expect(widened[2]!.price).toBeGreaterThan(placed.points[2]!.price);
  await dragHandle(page, 1, 30, -20);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[1]).not.toEqual(widened[1]);
  const moved = (await drawings(scenario))[0]!.points;
  expect([moved[0], moved[2]]).toEqual([widened[0], widened[2]]);
  expect(errors).toEqual([]);
});

test("line tools: dragging a regression channel handle changes only that point's time", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  await pickTool(page, "선", "회귀 채널");
  await clickAll(page, clicksOf("regression"));
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  const placed = (await drawings(scenario))[0]!;
  expect(placed.tool).toBe("regression");
  expect(placed.points).toHaveLength(2);
  await expect.poll(async () => (await mirror(page))[0]?.handles.length).toBe(2);
  await dragHandle(page, 1, 60, -80);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[1]!.t).not.toBe(placed.points[1]!.t);
  const moved = (await drawings(scenario))[0]!.points;
  expect(moved[0]).toEqual(placed.points[0]);
  expect(moved[1]!.price).toBe(placed.points[1]!.price);
  expect(moved[1]!.t).toBeGreaterThan(placed.points[1]!.t);
  await dragHandle(page, 0, -40, 50);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[0]!.t).toBeLessThan(placed.points[0]!.t);
  const again = (await drawings(scenario))[0]!.points;
  expect(again[0]!.price).toBe(placed.points[0]!.price);
  expect(again[1]).toEqual(moved[1]);
  expect(errors).toEqual([]);
});

test("line tools: dragging a pitchfork handle changes that saved point", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  await pickTool(page, "선", "피치포크");
  const [base, second, third] = clicksOf("pitchfork");
  await clickAll(page, [base!, second!]);
  expect(await drawings(scenario)).toHaveLength(0);
  await clickAll(page, [third!]);
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  const placed = (await drawings(scenario))[0]!;
  expect(placed.tool).toBe("pitchfork");
  expect(placed.points).toHaveLength(3);
  await expect.poll(async () => (await mirror(page))[0]?.handles.length).toBe(3);
  await dragHandle(page, 0, -30, 40);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[0]).not.toEqual(placed.points[0]);
  const moved = (await drawings(scenario))[0]!.points;
  expect(moved.slice(1)).toEqual(placed.points.slice(1));
  expect(moved[0]!.t).toBeLessThan(placed.points[0]!.t);
  expect(moved[0]!.price).toBeLessThan(placed.points[0]!.price);
  await dragHandle(page, 2, 20, 30);
  await pollSaved(async () => (await drawings(scenario))[0]!.points[2]).not.toEqual(placed.points[2]);
  expect((await drawings(scenario))[0]!.points.slice(0, 2)).toEqual(moved.slice(0, 2));
  expect(errors).toEqual([]);
});
