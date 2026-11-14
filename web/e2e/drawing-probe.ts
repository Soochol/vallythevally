import type { Page } from "@playwright/test";
import { cell, chartOf, expect, type Scenario } from "./harness";
import type { Drawing } from "../src/api/generated/Drawing";

export interface Mirror { id: string; tool: string; selected: boolean; points: ({ x: number; y: number } | null)[]; handles: { x: number; y: number }[] }

export async function mirror(page: Page): Promise<Mirror[]> {
  const json = await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings");
  return JSON.parse(json ?? "[]");
}

export async function settledMirror(page: Page): Promise<Mirror[]> {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await mirror(page));
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return mirror(page);
}

export const drawings = async (scenario: Scenario): Promise<Drawing[]> => scenario.documents.drawings("IDX:001");

export async function open(page: Page) {
  await page.goto("/");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}

export async function pickTool(page: Page, group: string, label: string) {
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  const toggle = bar.getByRole("button", { name: `${group} 도구 펼치기`, exact: true });
  if (await toggle.count()) {
    await toggle.click();
    await page.getByRole("menu", { name: `${group} 도구` }).getByRole("menuitem").getByText(label, { exact: true }).click();
  } else {
    await bar.getByRole("button", { name: label, exact: true }).click();
  }
  await expect(bar.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
}

export async function chartPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const r = (await chartOf(cell(page)).boundingBox())!;
  return { x: r.x + r.width * fx, y: r.y + r.height * fy };
}

type ScreenAt = { x: number; y: number };

export async function bodyAlong(page: Page, segments: readonly (readonly [ScreenAt, ScreenAt])[]): Promise<ScreenAt> {
  const host = chartOf(cell(page)).locator(".drawing-mirror");
  const cursor = () => host.evaluate((el) => (el.parentElement as HTMLElement).style.cursor);
  for (const [from, to] of segments) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    const run: ScreenAt[] = [];
    for (let i = 0; i <= steps; i++) {
      const at = { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps };
      await page.mouse.move(at.x, at.y);
      if (await cursor() === "move") run.push(at);
      else if (run.length > 0) break;
    }
    if (run.length > 0) return run[Math.floor(run.length / 2)]!;
  }
  throw new Error("드로잉의 몸통을 찾지 못했습니다");
}
