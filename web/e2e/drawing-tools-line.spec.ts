import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

type At = readonly [number, number];

const LINE_TOOLS: readonly { label: string; tool: string; clicks: readonly At[] }[] = [
  { label: "반직선", tool: "ray", clicks: [[0.3, 0.55], [0.4, 0.45]] },
  { label: "연장선", tool: "extline", clicks: [[0.45, 0.6], [0.55, 0.5]] },
  { label: "수평 반직선", tool: "hray", clicks: [[0.35, 0.3]] },
  { label: "수직선", tool: "vline", clicks: [[0.65, 0.4]] },
  { label: "평행 채널", tool: "channel", clicks: [[0.2, 0.7], [0.4, 0.62], [0.3, 0.5]] },
];

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

test("line tools: each toolbar pick saves its tool and point count and stays in place after reload", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  for (const [index, { label, tool, clicks }] of LINE_TOOLS.entries()) {
    await pickTool(page, "선", label);
    await clickAll(page, clicks);
    await expect.poll(async () => (await drawings(scenario)).length).toBe(index + 1);
    const saved = (await drawings(scenario)).at(-1)!;
    expect(saved.tool).toBe(tool);
    expect(saved.points).toHaveLength(clicks.length);
  }
  await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(LINE_TOOLS.map((t) => t.tool).sort());
  const stored = await drawings(scenario);
  const reloaded = async () => {
    await page.reload();
    await expect.poll(async () => (await mirror(page)).length).toBe(LINE_TOOLS.length);
    return mirror(page);
  };
  const before = await reloaded();
  const after = await reloaded();
  for (const item of before) {
    const again = after.find((d) => d.id === item.id)!;
    expect(again.tool).toBe(item.tool);
    again.points.forEach((p, i) => {
      expect(p!.x).toBeCloseTo(item.points[i]!.x, 0);
      expect(p!.y).toBeCloseTo(item.points[i]!.y, 0);
    });
  }
  expect(await drawings(scenario)).toEqual(stored);
  expect(errors).toEqual([]);
});

test("line tools: Alt+J picks the horizontal ray and Shift+V picks the vertical line", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  for (const { keys, label, tool, at } of [
    { keys: "Alt+j", label: "수평 반직선", tool: "hray", at: [0.4, 0.35] as At },
    { keys: "Shift+V", label: "수직선", tool: "vline", at: [0.6, 0.45] as At },
  ]) {
    await cell(page).focus();
    await page.keyboard.press(keys);
    await expect(bar.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await clickAll(page, [at]);
    await expect.poll(async () => (await drawings(scenario)).at(-1)?.tool).toBe(tool);
    expect((await drawings(scenario)).at(-1)!.points).toHaveLength(1);
  }
  expect(errors).toEqual([]);
});

test("line tools: three clicks place a parallel channel and its handles change the saved points", async ({ page, scenario }) => {
  const errors = watchErrors(page);
  await open(page);
  await pickTool(page, "선", "평행 채널");
  const [first, second, third] = LINE_TOOLS.find((t) => t.tool === "channel")!.clicks;
  await clickAll(page, [first!]);
  await clickAll(page, [second!]);
  expect(await drawings(scenario)).toHaveLength(0);
  await clickAll(page, [third!]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);
  const placed = (await drawings(scenario))[0]!;
  expect(placed).toMatchObject({ tool: "channel" });
  expect(placed.points).toHaveLength(3);
  await expect.poll(async () => (await mirror(page))[0]?.handles.length).toBe(3);
  const r = (await chartOf(cell(page)).boundingBox())!;
  const drag = async (index: number, dx: number, dy: number) => {
    const h = (await mirror(page))[0]!.handles[index]!;
    await page.mouse.move(r.x + h.x, r.y + h.y);
    await page.mouse.down();
    await page.mouse.move(r.x + h.x + dx, r.y + h.y + dy, { steps: 10 });
    await page.mouse.up();
  };
  await drag(2, 0, -40);
  await expect.poll(async () => (await drawings(scenario))[0]!.points[2]).not.toEqual(placed.points[2]);
  const widened = (await drawings(scenario))[0]!.points;
  expect(widened.slice(0, 2)).toEqual(placed.points.slice(0, 2));
  expect(widened[2]!.price).toBeGreaterThan(placed.points[2]!.price);
  await drag(1, 30, -20);
  await expect.poll(async () => (await drawings(scenario))[0]!.points[1]).not.toEqual(widened[1]);
  const moved = (await drawings(scenario))[0]!.points;
  expect([moved[0], moved[2]]).toEqual([widened[0], widened[2]]);
  expect(errors).toEqual([]);
});
