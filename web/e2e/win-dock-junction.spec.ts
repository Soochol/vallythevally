import type { Locator, Page } from "@playwright/test";
import { parsePlacement } from "../src/layout/placement";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 860 } });

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const groupWith = (page: Page, name: string) => page.locator("[data-dock-group]").filter({ has: tab(page, name) });
const menu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const handle = (page: Page) => page.locator("[data-dock-junction]");
const balloons = (page: Page) => page.locator("[data-dock-balloon]");
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const sizeOf = async (locator: Locator) => {
  const { width, height } = await boxOf(locator);
  return { width, height };
};

async function openThreeGroups(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await tab(page, "스크리너").press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "코스피 일", exact: true }).click();
  await tab(page, "스크리너").press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
  await expect(page.locator("[data-dock-group]")).toHaveCount(3);
}

async function sizes(page: Page) {
  return { chart: await sizeOf(page.locator('[data-dock-group][data-kind="chart"]')), screener: await sizeOf(groupWith(page, "스크리너")), watch: await sizeOf(groupWith(page, "관심종목")) };
}

async function grabHandle(page: Page) {
  const at = center(await boxOf(handle(page)));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  return at;
}

test("기본 도킹에는 교차점 손잡이가 없고 세 묶음 배치에는 하나 있다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(handle(page)).toHaveCount(0);
  await openThreeGroups(page);
  await expect(handle(page)).toHaveCount(1);
});

test("교차점을 왼쪽 위로 끌면 두 경계가 함께 움직이고 말풍선이 보이며 배치 되돌리기 한 번으로 돌아온다", async ({ page }) => {
  await openThreeGroups(page);
  const before = await sizes(page);
  await page.keyboard.down("Alt");
  const at = await grabHandle(page);
  await page.mouse.move(at.x - 100, at.y - 60, { steps: 8 });
  await expect(balloons(page)).toHaveCount(2);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(balloons(page)).toHaveCount(0);
  const after = await sizes(page);
  expect(after.chart.width).toBe(before.chart.width - 100);
  expect(after.chart.height).toBe(before.chart.height - 60);
  expect(after.screener.height).toBe(before.screener.height + 60);
  expect(after.watch.width).toBe(before.watch.width + 100);
  await tab(page, "관심종목").press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
  await expect.poll(() => sizes(page)).toEqual(before);
  await expect(page.locator("[data-dock-group]")).toHaveCount(3);
});

test("놓은 크기는 새로고침해도 그대로다", async ({ page, scenario }) => {
  await openThreeGroups(page);
  await page.keyboard.down("Alt");
  const at = await grabHandle(page);
  await page.mouse.move(at.x - 100, at.y - 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const placed = await sizes(page);
  await pollSaved(() => JSON.stringify(saved(scenario))).toContain('"ratio"');
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expect(await sizes(page)).toEqual(placed);
});

test("끄는 중 Esc는 두 경계를 끌기 전으로 돌리고 저장도 배치 기록도 만들지 않는다", async ({ page, scenario }) => {
  await openThreeGroups(page);
  await pollSaved(() => saved(scenario)).not.toBeNull();
  const savedBefore = JSON.stringify(saved(scenario));
  const before = await sizes(page);
  await page.keyboard.down("Alt");
  const at = await grabHandle(page);
  await page.mouse.move(at.x - 80, at.y - 50, { steps: 6 });
  await expect.poll(async () => (await sizes(page)).chart.width).toBe(before.chart.width - 80);
  await page.keyboard.press("Escape");
  await expect(balloons(page)).toHaveCount(0);
  await expect.poll(() => sizes(page)).toEqual(before);
  await page.mouse.move(at.x - 120, at.y - 90, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await sizes(page)).toEqual(before);
  expect(JSON.stringify(saved(scenario))).toBe(savedBefore);
  await tab(page, "관심종목").press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
  await expect(page.locator("[data-dock-group]")).toHaveCount(2);
});

test("한 방향이 최소에 닿아도 다른 방향은 계속 움직이고 닿은 방향의 알림이 한 번 뜬다", async ({ page }) => {
  await openThreeGroups(page);
  const before = await sizes(page);
  await page.keyboard.down("Alt");
  const at = await grabHandle(page);
  await page.mouse.move(at.x - 40, at.y - 20, { steps: 4 });
  await page.mouse.move(at.x - 900, at.y - 40, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const notice = page.getByRole("status").filter({ hasText: "왼쪽 창은 폭" });
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeVisible();
  const after = await sizes(page);
  expect(after.chart.width).toBeLessThan(before.chart.width - 200);
  expect(after.chart.height).toBe(before.chart.height - 40);
  expect(after.screener.height).toBe(before.screener.height + 40);
});
