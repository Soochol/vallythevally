import type { Page } from "@playwright/test";
import { allResult } from "./fixtures/screener";
import { cell, DEFAULT_LAYOUT_ID, expect, type Scenario, test, pollSaved } from "./screener-harness";
import { openScreener, rowOf, rows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";
import { firstChart } from "./harness";

const result = allResult();
const [first, second] = result.rows;
const last = result.rows.at(-1)!;
const menu = (page: Page) => page.getByRole("menu", { name: /행 동작$/ });
const listMenu = (page: Page) => page.getByRole("menu", { name: /관심종목에 넣기$/ });
const toast = (page: Page) => page.locator(".ui-toast");
const compareOf = async (scenario: Scenario) => (firstChart(await scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings as { compare: string[] }).compare;

test.beforeEach(async ({ scenario, screener, page }) => {
  scenario.documents.saveScreens({ revision: 1, screens: [{ id: "all", name: "모든 종목", markets: [], exclude: [], conditions: [] }] });
  scenario.documents.saveWatchlists({ revision: 100, lists: [
    { id: "base", name: "기본", symbols: [first!.symbol] },
    { id: "chips", name: "반도체", symbols: [] },
  ] });
  screener.showResult(result);
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(rows(page)).toHaveCount(result.rows.length);
});

const openMenu = (page: Page, code: string) => rowOf(page, code).getByRole("button").click({ button: "right" });

test("우클릭은 머리와 네 항목의 메뉴를 열고 칸의 종목을 바꾸지 않는다", async ({ page }) => {
  const label = await cell(page).getAttribute("aria-label");
  await openMenu(page, second!.symbol);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText(`${second!.name} ${second!.symbol}`);
  await expect(menu(page).getByRole("menuitem")).toHaveText([/^이 칸에 열기/, /^비교에 추가/, /^관심종목에 넣기/, /^종목코드 복사/]);
  await expect(menu(page).getByRole("menuitem", { name: /^이 칸에 열기/ })).toContainText("↵");
  await expect(menu(page).getByRole("menuitem", { name: /^비교에 추가/ })).toContainText("Shift+↵");
  expect(await cell(page).getAttribute("aria-label")).toBe(label);
  await expect(rowOf(page, second!.symbol).getByRole("button")).not.toHaveAttribute("aria-current", "true");
});

test("이 칸에 열기는 활성 칸의 종목을 바꾼다", async ({ page }) => {
  await openMenu(page, second!.symbol);
  await menu(page).getByRole("menuitem", { name: /^이 칸에 열기/ }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${second!.name} 통합 일`);
});

test("비교에 추가는 활성 칸에 비교 종목을 넣고 알리며 이미 있으면 거절한다", async ({ scenario, page }) => {
  await openMenu(page, second!.symbol);
  await menu(page).getByRole("menuitem", { name: /^비교에 추가/ }).click();
  await expect(toast(page)).toContainText(`비교에 추가했습니다: ${second!.name}`);
  await pollSaved(() => compareOf(scenario)).toEqual([second!.symbol]);
  await openMenu(page, second!.symbol);
  await menu(page).getByRole("menuitem", { name: /^비교에 추가/ }).click();
  await expect(toast(page)).toContainText("이미 비교에 있습니다");
});

test("관심종목에 넣기는 목록 메뉴로 바뀌고 이미 든 목록은 누를 수 없다", async ({ scenario, page }) => {
  await openMenu(page, first!.symbol);
  await menu(page).getByRole("menuitem", { name: /^관심종목에 넣기/ }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(listMenu(page)).toBeVisible();
  const held = listMenu(page).getByRole("menuitem", { name: /^기본/ });
  await expect(held).toBeDisabled();
  await expect(held).toContainText("이미 있음");
  await listMenu(page).getByRole("menuitem", { name: /^반도체/ }).click();
  await expect(toast(page)).toContainText(`반도체에 넣었습니다: ${first!.name}`);
  await pollSaved(() => scenario.documents.watchlists().lists[1]!.symbols).toEqual([first!.symbol]);
});

test("종목코드 복사는 클립보드에 코드를 넣고 알린다", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await openMenu(page, second!.symbol);
  await menu(page).getByRole("menuitem", { name: /^종목코드 복사/ }).click();
  await expect(toast(page)).toContainText(`종목코드를 복사했습니다: ${second!.symbol}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second!.symbol);
});

test("Shift+F10으로 열고 Esc로 닫으면 그 줄로 초점이 돌아가며 Shift+↵는 비교에 추가다", async ({ scenario, page }) => {
  const button = rowOf(page, second!.symbol).getByRole("button");
  await button.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Shift+Enter");
  await expect(toast(page)).toContainText(`비교에 추가했습니다: ${second!.name}`);
  await pollSaved(() => compareOf(scenario)).toEqual([second!.symbol]);
});

test("아래 가장자리의 줄에서 열어도 메뉴가 화면 안에 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 520 });
  const target = rowOf(page, last.symbol);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.click(Math.min(box.x + box.width - 4, 1020), box.y + box.height - 2, { button: "right" });
  await expect(menu(page)).toBeVisible();
  const inside = await menu(page).evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  expect(inside).toBe(true);
});
