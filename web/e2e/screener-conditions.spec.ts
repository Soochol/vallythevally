import { resultRows, type ScreenerScenario } from "./fixtures/screener";
import { expectSentences, fillNumber, renameScreen, expandEditor, savedEditor, addCondition, conditionAction, chooseKind } from "./sentence-editor";
import { selectOption } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./screener-harness";
import { editor, excludedLine, expectCellOn, expectRows, openScreener, panel, pickPeriod, pickVenue, results, rows, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";


const SCREEN_NAME = "교차 급증 주봉 신고가";
const CROSS = "이평 교차 일봉 최근 5일 이내에 단순 짧은 이평 5일선이 20일선을 위로 교차한 봉이 있다";
const WEEKLY_HIGH = "신고가 주봉 최근 1주 이내에 종가가 52주 신고가인 봉이 있다";
const SURGE = "거래 급증 일봉 최근 10일 이내에 거래량이 직전 20일 평균의 3배 이상인 봉이 있다";
const RISE = "등락률 일봉 최근 10일 이내에 종가가 1일 전보다 5% 이상인 봉이 있다";
const MARKET_CAP = "시가총액 3000억 원 이상이다";

const KOSPI_HIT = ["120010", "가상교차급증", "11-05"] as const;
const KOSDAQ_HIT = ["120020", "가상코스닥교차", "11-04"] as const;

const choice = (dialog: Locator, line: number, name: string) => dialog.getByRole("combobox", { name: `조건 ${line} ${name}` });
const box = (dialog: Locator, line: number, name: string) => dialog.getByRole("button", { name: `조건 ${line} ${name}`, exact: true });

async function editScreen(page: Page) {
  await expandEditor(page);
  return editor(page, "조건식 편집");
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await savedEditor(dialog);
}

async function runAndExpect(page: Page, screener: ScreenerScenario, excluded: string, expected: readonly (readonly [code: string, name: string, matchedDate: string])[], universe = 16, listedTooShort = 2) {
  screener.showResult(resultRows(expected, { universe, excluded: { listedTooShort, historyShort: 0, unconfirmed: 0 } }));
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
  await expect(results(page)).toContainText(`${expected.length}종목 · 11-06(금) 기준`);
  await expect(excludedLine(page)).toHaveText(excluded);
  await expectRows(page, expected.map(([code, name]) => [code, name]));
}

test("봉·지표·시가총액 줄을 일봉과 주봉으로 편집·정렬·저장하고 서버 결과의 종목을 차트로 열며 잘못된 값과 시장 설정을 구분한다", async ({ scenario, screener, page }) => {
  const barRequests: string[] = [];
  const screenSaves: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/bars") barRequests.push(`${url.searchParams.get("symbol")}:${url.searchParams.get("venue")}:${url.searchParams.get("period")}`);
    if (req.method() === "PUT" && url.pathname === "/api/screens") screenSaves.push(req.postData() ?? "");
  });
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");

  await test.step("주봉 신고가, 일봉 거래 급증, 일봉 이평 교차, 시가총액 줄을 차례로 만든다", async () => {
    await panel(page).getByRole("button", { name: "새 조건식" }).click();
    const dialog = editor(page, "새 조건식");
    await renameScreen(dialog, SCREEN_NAME);
    await addCondition(dialog);
    await selectOption(choice(dialog, 1, "봉 주기"), "W");
    await selectOption(choice(dialog, 1, "값"), "close");
    await fillNumber(box(dialog, 1, "신고가 기간"), "52");

    await addCondition(dialog);
    await expect(choice(dialog, 2, "봉 주기")).toHaveAttribute("data-value", "W");
    await chooseKind(dialog, 2, "surge");
    await selectOption(choice(dialog, 2, "봉 주기"), "D");
    await fillNumber(box(dialog, 2, "최근 기간"), "10");

    await addCondition(dialog);
    await expect(choice(dialog, 3, "봉 주기")).toHaveAttribute("data-value", "D");
    await chooseKind(dialog, 3, "ma_cross");
    await fillNumber(box(dialog, 3, "최근 기간"), "5");

    await addCondition(dialog);
    await chooseKind(dialog, 4, "market_cap");
    await expect(choice(dialog, 4, "봉 주기")).toHaveCount(0);
    await expectSentences(dialog, [WEEKLY_HIGH, SURGE, CROSS, MARKET_CAP]);
  });

  await test.step("▲▼로 이평 교차 줄을 맨 위로 올리고 저장한다", async () => {
    const dialog = editor(page, "새 조건식");
    await conditionAction(dialog, 3, "위로 옮기기");
    await expectSentences(dialog, [WEEKLY_HIGH, CROSS, SURGE, MARKET_CAP]);
    await conditionAction(dialog, 1, "아래로 옮기기");
    await expectSentences(dialog, [CROSS, WEEKLY_HIGH, SURGE, MARKET_CAP]);
    await save(page, dialog);

    await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(SCREEN_NAME);
    await expectSentences(panel(page), [CROSS, WEEKLY_HIGH, SURGE, MARKET_CAP]);
    const stored = scenario.documents.screens();
    expect(stored.screens).toEqual([
      {
        id: expect.any(String),
        name: SCREEN_NAME,
        markets: [],
        exclude: [],
        conditions: [
          { kind: "ma_cross", period: "D", recentBars: 5, method: "sma", fast: 5, slow: 20, direction: "up" },
          { kind: "new_high", period: "W", recentBars: 1, field: "close", n: 52 },
          { kind: "surge", period: "D", recentBars: 10, field: "volume", n: 20, times: 3 },
          { kind: "market_cap", min: 300_000_000_000, max: null },
        ],
      },
    ]);
  });

  await test.step("실행하면 모든 줄을 넘은 두 종목이 교차한 날짜로 나오고, 주봉 52칸이 모자란 두 종목은 상장 기간 부족으로 빠진다", async () => {
    await runAndExpect(page, screener, "대상 16종목 · 빠짐: 상장 기간 부족 2 · 이력 덜 참 0", [KOSPI_HIT, KOSDAQ_HIT]);
  });

  await test.step("KRX와 월봉을 고른 칸에서 다른 행을 열면 그 종목을 KRX 월봉으로 요청한다", async () => {
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상교차급증 통합 일");
    await pickVenue(page, "KRX");
    await pickPeriod(page, "월");
    await expectCellOn(page, rows(page).nth(0), "가상교차급증 KRX 월");
    await rows(page).nth(1).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(1), "가상코스닥교차 KRX 월");
    expect(barRequests).toContain("120020:krx:M");
  });

  await test.step("거래 급증 줄을 등락률로 바꾸면 봉 주기와 M은 남고, 짧은 이평이 긴 이평보다 길거나 최대가 최소보다 작으면 그 칸에서 이유와 함께 저장이 막힌다", async () => {
    const dialog = await editScreen(page);
    await chooseKind(dialog, 3, "change");
    await expect(choice(dialog, 3, "봉 주기")).toHaveAttribute("data-value", "D");
    await expect(box(dialog, 3, "최근 기간")).toHaveText("10");
    await expect(box(dialog, 3, "비교 봉 수")).toHaveText("1");
    await expect(box(dialog, 3, "최소 등락률")).toHaveText("5");
    await expect(box(dialog, 3, "최대 등락률")).toHaveCount(0);
    await expectSentences(dialog, [CROSS, WEEKLY_HIGH, RISE, MARKET_CAP]);

    await fillNumber(box(dialog, 1, "짧은 이평"), "20");
    await selectOption(choice(dialog, 3, "비교"), "range");
    await fillNumber(box(dialog, 3, "최대 등락률"), "3");
    await expectSentences(dialog, ["짧은 이평: 긴 이평 20일보다 짧아야 합니다", WEEKLY_HIGH, "최대 등락률: 최소보다 작을 수 없습니다", MARKET_CAP]);
    await expect(box(dialog, 1, "짧은 이평")).toHaveAttribute("aria-invalid", "true");
    await expect(box(dialog, 3, "최대 등락률")).toHaveAttribute("aria-invalid", "true");
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(box(dialog, 1, "짧은 이평")).toBeFocused();
    await expect(dialog).toBeVisible();

    await fillNumber(box(dialog, 1, "짧은 이평"), "5");
    await fillNumber(box(dialog, 3, "최대 등락률"), "");
    await expectSentences(dialog, [CROSS, WEEKLY_HIGH, RISE, MARKET_CAP]);
    await save(page, dialog);
    expect(screenSaves).toHaveLength(2);
  });
});
