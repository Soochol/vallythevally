import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { Scenario } from "./fixtures/scenario";
export { DEFAULT_LAYOUT_ID, firstChart, withFirstChart, type Scenario } from "./fixtures/scenario";

export const test = base.extend<{ scenario: Scenario; clockStart: string | null }>({
  clockStart: [null, { option: true }],
  scenario: [async ({ context, clockStart }, use) => {
    const now = clockStart ? Date.parse(`${clockStart.slice(0,4)}-${clockStart.slice(4,6)}-${clockStart.slice(6,8)}T${clockStart.slice(8,10)}:${clockStart.slice(10,12)}:${clockStart.slice(12,14)}+09:00`) : undefined;
    const scenario = new Scenario(now);
    await scenario.install(context);
    try { await use(scenario); } finally { await scenario.close(); }
  }, { auto: true }],
});
export { expect };

export const SEARCH_BUTTON_TITLE = "종목 검색 (/ 또는 Ctrl+K)";

export const cell = (page: Page, n = 1): Locator => page.getByRole("region", { name: new RegExp(`^칸 ${n}: `) });

export const chartOf = (c: Locator): Locator => c.locator("[data-bar-count]");

export async function barTimes(chart: Locator): Promise<{ count: number; first: number }> {
  const [count, first] = await Promise.all([chart.getAttribute("data-bar-count"), chart.getAttribute("data-first-bar-t")]);
  return { count: Number(count), first: Number(first) };
}

export async function dragTowardPast(page: Page, chart: Locator, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    const box = await chart.boundingBox();
    if (!box) throw new Error("차트가 보이지 않습니다");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 12 });
    await page.mouse.up();
    await until();
  }).toPass({ timeout: 30_000, intervals: [0] });
}
