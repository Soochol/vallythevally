import type { Locator, Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

async function expectCellShows(page: Page, label: string) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

async function choose(group: Locator, name: string) {
  const button = group.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test.describe("데스크톱", () => {
  test("거래소와 봉 주기를 바꾸면 칸이 그 봉을 그린다", async ({ page }) => {
    await page.goto("/?symbol=005930");
    const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
    const venues = toolbar.getByRole("group", { name: "거래소" });
    const periods = toolbar.getByRole("group", { name: "봉 주기" });
    await expectCellShows(page, "삼성전자 통합 일");

    await choose(venues, "KRX");
    await expectCellShows(page, "삼성전자 KRX 일");
    await choose(venues, "NXT");
    await expectCellShows(page, "삼성전자 NXT 일");
    await choose(venues, "통합");
    await expectCellShows(page, "삼성전자 통합 일");

    for (const [period, label] of [["주", "주"], ["월", "월"], ["5분", "5분"], ["1분", "1분"], ["일", "일"]] as const) {
      await choose(periods, period);
      await expectCellShows(page, `삼성전자 통합 ${label}`);
    }
  });

  test("NXT에서 거래되지 않는 종목은 NXT를 고를 수 없다", async ({ page }) => {
    await page.goto("/?symbol=005935");
    const venues = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "거래소" });
    await expectCellShows(page, "삼성전자우 통합 일");
    const nxt = venues.getByRole("button", { name: "NXT, NXT에서 거래되지 않는 종목" });
    await expect(nxt).toHaveAttribute("aria-disabled", "true");
    await nxt.click({ force: true });
    await expect(nxt).toHaveAttribute("aria-pressed", "false");
    await expectCellShows(page, "삼성전자우 통합 일");
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("봉 주기 칩과 거래소를 바꾸면 칸이 그 봉을 그린다", async ({ page }) => {
    await page.goto("/?symbol=005930");
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeHidden();
    const venues = page.getByRole("group", { name: "거래소" });
    const chips = page.getByRole("navigation", { name: "봉 주기" });
    await expectCellShows(page, "삼성전자 통합 일");

    await choose(chips, "5분");
    await expectCellShows(page, "삼성전자 통합 5분");
    await choose(chips, "월");
    await expectCellShows(page, "삼성전자 통합 월");
    await choose(venues, "KRX");
    await expectCellShows(page, "삼성전자 KRX 월");
    await choose(venues, "NXT");
    await expectCellShows(page, "삼성전자 NXT 월");
  });
});
