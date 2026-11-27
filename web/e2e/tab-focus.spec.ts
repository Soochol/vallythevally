import type { Locator, Page } from "@playwright/test";
import { cell, expect, type Scenario, test, windowTab } from "./harness";
import { openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const arrange = (page: Page) => page.getByRole("button", { name: "배치", exact: true });
const focusOnBody = (page: Page) => page.evaluate(() => document.activeElement === document.body);

function seed(scenario: Scenario) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols: ["005930", "086520"], groups: [] }] });
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function keepsFocus(page: Page, target: Locator) {
  await target.focus();
  await expect(target).toBeFocused();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(target).toBeFocused();
  }
}

test("창 안의 초점은 Tab을 앞뒤로 눌러도 그대로다", async ({ page, scenario }) => {
  seed(scenario);
  await open(page);
  await keepsFocus(page, cell(page));
  await keepsFocus(page, panel(page).locator('li[data-code="005930"] [data-main]'));
  await keepsFocus(page, windowTab(page, "관심종목"));
  await keepsFocus(page, page.getByRole("separator", { name: "좌우 창 경계" }).first());
});

test("초점이 없으면 Tab을 눌러도 어디에도 초점이 생기지 않는다", async ({ page }) => {
  await open(page);
  expect(await focusOnBody(page)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await focusOnBody(page)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await focusOnBody(page)).toBe(true);
});

test("위 막대와 상태 줄에서도 Tab은 초점을 옮기지 않는다", async ({ page }) => {
  await open(page);
  await keepsFocus(page, arrange(page));
  await keepsFocus(page, page.locator("footer.status-bar").locator("button:not(:disabled), a[href]").first());
});

test("주문 수량 칸에서 Tab을 눌러도 수량 칸에 남고 값은 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const quantity = win(page).locator(".od-qty-input");
  await quantity.fill("7");
  await keepsFocus(page, quantity);
  await expect(quantity).toHaveValue("7");
});

test("작업 화면에서는 막고 종목 검색 안에서는 Tab이 동작한다", async ({ page }) => {
  await open(page);
  await keepsFocus(page, arrange(page));
  await page.getByRole("button", { name: "종목·지표·명령 찾기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("group", { name: "변경 대상" }).getByRole("button", { name: "B그룹", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+Tab");
  await expect(input).not.toBeFocused();
  await expect(dialog.locator(":focus")).toHaveCount(1);
});

test("작업 화면에서는 막고 시장 종합 화면에서는 Tab이 초점을 옮긴다", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Tab");
  expect(await focusOnBody(page)).toBe(true);
  await page.goto("/market");
  await expect(page.getByRole("main", { name: "시장 종합", exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect.poll(() => focusOnBody(page)).toBe(false);
});
