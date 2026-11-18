import { selectMinute } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import type { SeriesKey } from "../src/api/bars";
import { cell, chartOf, expect, test, pickDesktopVenue, expectDesktopVenue, pollSaved } from "./harness";

function recordBarRequests(page: Page): SeriesKey[] {
  const seen: SeriesKey[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname !== "/api/bars") return;
    const q = url.searchParams;
    seen.push({ symbol: q.get("symbol")!, venue: q.get("venue") as SeriesKey["venue"], period: q.get("period") as SeriesKey["period"] });
  });
  return seen;
}

function watchCell(page: Page, symbol: string) {
  const requested = recordBarRequests(page);
  return (label: string, venue: SeriesKey["venue"], period: SeriesKey["period"]) =>
    expectCellShows(page, requested, label, { symbol, venue, period });
}

async function expectCellShows(page: Page, requested: SeriesKey[], label: string, series: SeriesKey) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label}`);
  await pollSaved(() => requested.at(-1), { message: `${label}의 마지막 봉 요청` }).toEqual(series);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

async function choose(group: Locator, name: string) {
  const minutes = group.getByRole("button", { name: "분봉", exact: true });
  if (/^\d+분$/.test(name) && await minutes.count()) {
    await selectMinute(minutes, { label: name });
    await expect(minutes).toHaveAttribute("data-value", name.replace("분", "m"));
    return;
  }
  const button = group.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test.describe("데스크톱", () => {
  test("거래소와 봉 주기를 바꾸면 칸이 그 봉을 그린다", async ({ page }) => {
    const expectCellShows = watchCell(page, "005930");
    await page.goto("/?symbol=005930");
    const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
    const periods = toolbar.getByRole("group", { name: "봉 주기" });
    await expectCellShows("삼성전자 통합 일", "combined", "D");

    await pickDesktopVenue(page, "KRX");
    await expectCellShows("삼성전자 KRX 일", "krx", "D");
    await pickDesktopVenue(page, "NXT");
    await expectCellShows("삼성전자 NXT 일", "nxt", "D");
    await pickDesktopVenue(page, "통합");
    await expectCellShows("삼성전자 통합 일", "combined", "D");

    for (const [button, period] of [["주", "W"], ["월", "M"], ["5분", "5m"], ["1분", "1m"], ["일", "D"]] as const) {
      await choose(periods, button);
      await expectCellShows(`삼성전자 통합 ${button}`, "combined", period);
    }
  });

  test("NXT에서 거래되지 않는 종목은 NXT를 눌러도 통합 봉을 그리고 위 막대는 NXT로 남는다", async ({ page }) => {
    const expectCellShows = watchCell(page, "005935");
    await page.goto("/?symbol=005935");
    await expectCellShows("삼성전자우 통합 일", "combined", "D");
    await pickDesktopVenue(page, "NXT");
    await expectDesktopVenue(page, "NXT");
    await expectCellShows("삼성전자우 통합 일", "combined", "D");
    await expect(cell(page).getByText("통합", { exact: true })).toBeVisible();
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("봉 주기 칩과 거래소를 바꾸면 칸이 그 봉을 그린다", async ({ page }) => {
    const expectCellShows = watchCell(page, "005930");
    await page.goto("/?symbol=005930");
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeHidden();
    const venues = page.getByRole("group", { name: "거래소" });
    const chips = page.getByRole("navigation", { name: "봉 주기" });
    await expectCellShows("삼성전자 통합 일", "combined", "D");

    await choose(chips, "5분");
    await expectCellShows("삼성전자 통합 5분", "combined", "5m");
    await choose(chips, "월");
    await expectCellShows("삼성전자 통합 월", "combined", "M");
    await choose(venues, "KRX");
    await expectCellShows("삼성전자 KRX 월", "krx", "M");
    await choose(venues, "NXT");
    await expectCellShows("삼성전자 NXT 월", "nxt", "M");
  });
});
