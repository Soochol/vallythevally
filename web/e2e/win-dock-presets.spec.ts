import type { Locator, Page } from "@playwright/test";
import { cell, DEFAULT_LAYOUT_ID, expect, test, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 860 } });

const groups = (page: Page) => page.locator("[data-dock-group]");
const tabMenu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const dividerMenu = (page: Page) => page.getByRole("menu", { name: "경계 크기" });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "레이아웃", exact: true });
const sideways = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" });
const stacked = (page: Page) => page.getByRole("separator", { name: "위아래 창 경계" });
const layoutTrigger = (page: Page) => page.getByRole("button", { name: /^레이아웃:/ });
const choice = (page: Page, name: string) => dividerMenu(page).getByRole("menuitem", { name: new RegExp(`^${name.replace("/", "\\/")}( |$)`) });
const widthOf = async (locator: Locator) => (await locator.boundingBox())!.width;
const heightOf = async (locator: Locator) => (await locator.boundingBox())!.height;
const widths = async (page: Page) => [await widthOf(groups(page).nth(0)), await widthOf(groups(page).nth(1))];

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function layoutAction(page: Page, name: string) {
  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name, exact: true }).click();
}

async function pick(page: Page, name: string) {
  await sideways(page).click({ button: "right" });
  await choice(page, name).click();
}

async function undoFromDivider(page: Page, divider: Locator) {
  await divider.click({ button: "right" });
  await choice(page, "배치 되돌리기").click();
}

test("좌우 경계를 우클릭해 반반을 고르면 폭 차이가 1px 안이고 저장되며 배치 되돌리기 한 번으로 돌아온다", async ({ page, scenario }) => {
  await open(page);
  const before = await widths(page);
  await pick(page, "반반");
  await expect.poll(async () => Math.abs((await widths(page)).reduce((a, b) => a - b))).toBeLessThanOrEqual(1);
  const even = await widths(page);
  await pollSaved(() => JSON.stringify(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement)).toContain("0.5");
  await undoFromDivider(page, sideways(page));
  await expect.poll(() => widths(page)).toEqual(before);
  await pick(page, "반반");
  await expect.poll(() => widths(page)).toEqual(even);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expect(await widths(page)).toEqual(even);
});

test("기본 비율은 기본 배치로와 같은 폭이 되고 이미 기본 비율일 때는 비활성이다", async ({ page }) => {
  await open(page);
  const initial = await widths(page);
  await sideways(page).click({ button: "right" });
  await expect(choice(page, "기본 비율")).toBeDisabled();
  await page.keyboard.press("Escape");
  await pick(page, "반반");
  await expect.poll(() => widths(page)).not.toEqual(initial);
  await pick(page, "기본 비율");
  await expect.poll(() => widths(page)).toEqual(initial);
  await pick(page, "반반");
  await layoutAction(page, "기본 배치로");
  await expect.poll(() => widths(page)).toEqual(initial);
});

test("좁은 창에서는 왼쪽 2/3이 비활성이고 이유 힌트가 있다", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await open(page);
  await page.getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^스크리너/ }).click();
  await sideways(page).click({ button: "right" });
  await expect(choice(page, "왼쪽 2/3")).toBeDisabled();
  await expect(dividerMenu(page).getByText("최소 폭 때문에 맞출 수 없습니다")).toHaveCount(1);
  await expect(choice(page, "반반")).toBeEnabled();
});

test("경계에 초점을 두고 Shift+F10으로 열어 키보드만으로 반반을 고르고 초점이 경계에 돌아온다", async ({ page }) => {
  await open(page);
  const divider = sideways(page);
  await divider.focus();
  await page.keyboard.press("Shift+F10");
  await expect(dividerMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dividerMenu(page)).toHaveCount(0);
  await expect(divider).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(choice(page, "반반")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.abs((await widths(page)).reduce((a, b) => a - b))).toBeLessThanOrEqual(1);
  await expect(divider).toBeFocused();
});

test("세로로 쌓은 차트 셋은 같은 방향 고르게와 크기 모두 고르게로 높이가 같아지고 각각 한 번에 되돌아오며 캔버스에서는 비활성이다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await open(page);
  const chartGroups = page.locator('[data-dock-group][data-kind="chart"]');
  const splitDown = async () => {
    await groups(page).nth(0).getByRole("button", { name: "이 묶음에 창 더하기" }).click();
    await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
    await groups(page).nth(0).getByRole("tab").last().click({ button: "right" });
    await tabMenu(page).getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
  };
  await splitDown();
  await expect(chartGroups).toHaveCount(2);
  await stacked(page).first().click({ button: "right" });
  await choice(page, "위 2/3").click();
  await splitDown();
  await expect(chartGroups).toHaveCount(3);
  await stacked(page).last().click({ button: "right" });
  await choice(page, "위 2/3").click();
  const heights = async () => [await heightOf(chartGroups.nth(0)), await heightOf(chartGroups.nth(1)), await heightOf(chartGroups.nth(2))];
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  await expect.poll(async () => spread(await heights())).toBeGreaterThan(20);
  const before = await heights();

  await stacked(page).first().click({ button: "right" });
  await choice(page, "같은 방향 고르게").click();
  await expect.poll(async () => spread(await heights())).toBeLessThanOrEqual(1);
  await undoFromDivider(page, stacked(page).first());
  await expect.poll(heights).toEqual(before);

  await layoutAction(page, "크기 모두 고르게");
  await expect.poll(async () => spread(await heights())).toBeLessThanOrEqual(1);
  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
  await expect.poll(heights).toEqual(before);

  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("button", { name: "캔버스", exact: true }).click();
  await expect(layoutMenu(page).getByRole("menuitem", { name: "크기 모두 고르게", exact: true })).toBeDisabled();
});
