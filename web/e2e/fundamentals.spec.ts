import type { Page } from "@playwright/test";
import { cell, chartOf, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

const RETRYABLE_WITHOUT_CLOSING_GATE = { return_code: 2, return_msg: "입력값 오류[1501:입력값을 확인하세요]" };

const panel = (page: Page) => page.getByRole("region", { name: "종목 정보" });
const value = (page: Page, label: string) =>
  panel(page).locator("div").filter({ has: page.getByRole("term").filter({ hasText: label }) }).getByRole("definition");

test("종목을 바꾸면 종목 정보가 그 종목의 값으로 바뀐다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(panel(page)).toContainText("삼성전자");
  await expect(value(page, "시가총액")).toHaveText("1,130.67조");
  await expect(value(page, "PER")).toHaveText("21.50배");
  await expect(value(page, "52주 최고")).toHaveText("214,000");

  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("086520");
  await dialog.getByRole("option").filter({ hasText: "086520" }).click();

  await expect(panel(page)).toContainText("에코프로");
  await expect(value(page, "시가총액")).toHaveText("12.92조");
  await expect(value(page, "EPS")).toHaveText("−1,138원");
});

test("지수를 열면 종목 정보를 숨긴다", async ({ page }) => {
  await page.goto("/?symbol=IDX:001");
  await expect(cell(page)).toHaveAttribute("aria-label", /코스피/);
  await expect(panel(page)).toHaveCount(0);
});

test("키움이 실패하면 종목 정보만 오류를 보이고 차트는 그대로 그린다", async ({ app, page }) => {
  await app.fake.respondWith({ apiId: "ka10001", status: 200, body: RETRYABLE_WITHOUT_CLOSING_GATE });
  await page.goto("/?symbol=005930");
  const alert = panel(page).getByRole("alert");
  await expect(alert).toContainText("종목 정보를 받지 못했습니다.");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  await expect(cell(page).getByRole("alert")).toHaveCount(0);

  await app.fake.reset();
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(value(page, "PER")).toHaveText("21.50배");
});
