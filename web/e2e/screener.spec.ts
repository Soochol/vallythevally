import type { Condition } from "../src/api/generated/Condition";
import type { Screen } from "../src/api/generated/Screen";
import type { ScreenerStatus } from "../src/api/generated/ScreenerStatus";
import { emptyStatus, highResult, readyStatus, resultRows, runError, symbolInfo } from "./fixtures/screener";
import { expectKind, fillNumber, renameScreen, expandEditor, savedEditor, addCondition, toggleExclude, screenAction } from "./sentence-editor";
import { selectOption } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import { type Scenario, cell, chartOf, expect, SEARCH_BUTTON_TITLE, test } from "./screener-harness";
import { editor, excludedLine, expectCellOn, expectRows, openScreener, panel, pickPeriod, pickVenue, rail, results, rows, runButton, savedTo, screenChooser, storeLine, updateBand, waitForUpdateToFinish } from "./screener-page";

const SCREEN_NAME = "고가 60일 신고가";
const EDITED_NAME = "고가 60일 신고가 정지 제외";

const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });

async function expectWatchlistOfResults(page: Page) {
  await expect(watchPanel(page).getByRole("button", { name: /^관심종목 목록: / })).toHaveAccessibleName(`관심종목 목록: ${SCREEN_NAME}`);
  await expect.poll(() => watchPanel(page).locator("li[data-code]").evaluateAll((li) => li.map((e) => e.getAttribute("data-code")))).toEqual(["110030", "110035", "110040", "110050"]);
}

const SEEDED_SCREEN: Screen = { id: "seeded", name: SCREEN_NAME, markets: [], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }] };
const phoneTabs = (page: Page) => page.getByRole("navigation", { name: "휴대폰 탭" });
const openPhoneScreener = (page: Page) => phoneTabs(page).getByRole("button", { name: "스크리너" }).click();

async function runSeededScreen(scenario: Scenario, page: Page, openPanel: (page: Page) => Promise<void>) {
  scenario.documents.saveScreens({ screens: [SEEDED_SCREEN], revision: 1 });
  await page.goto("/");
  await openPanel(page);
  await expect(screenChooser(page)).toHaveText(SCREEN_NAME);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(rows(page)).toHaveCount(4);
}

async function holdSymbolInfo(scenario: Scenario, page: Page, code: string) {
  const path = `/api/symbols/${code}`;
  const held = scenario.hold(path);
  return {
    requested: held.received,
    release: async () => {
      const finished = page.waitForEvent("requestfinished", (request) => new URL(request.url()).pathname === path);
      held.reply({ body: symbolInfo(code) });
      await finished;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    },
  };
}

test("업데이트 상태와 조건식 결과를 표시하고 종목을 칸의 거래소와 봉 주기대로 열며, 자료 부족을 안내하고 조건식을 고치고 지운다", async ({ screener, page }) => {
  const barRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/bars") barRequests.push(`${url.searchParams.get("symbol")}:${url.searchParams.get("venue")}:${url.searchParams.get("period")}`);
  });
  await page.goto("/");
  await openScreener(page);

  await test.step("빈 저장소에서 처음 받기", async () => {
    await expect(updateBand(page)).toContainText("아직 받은 KRX 일봉이 없습니다");
    await expect(panel(page).getByText("저장한 조건식이 없습니다")).toBeVisible();
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await expect(storeLine(page)).toContainText("빠진 관측일 없음");
  });

  await test.step("조건식 만들기", async () => {
    await panel(page).getByRole("button", { name: "새 조건식" }).click();
    const dialog = editor(page, "새 조건식");
    await renameScreen(dialog, SCREEN_NAME);
    await addCondition(dialog);
    await fillNumber(dialog.getByRole("button", { name: "조건 1 신고가 기간" }), "60");
    await fillNumber(dialog.getByRole("button", { name: "조건 1 최근 기간" }), "20");
    await toggleExclude(dialog, "종류", "ETF");
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await savedEditor(dialog);
    await expect(screenChooser(page)).toHaveText(SCREEN_NAME);
    await expect(panel(page).getByRole("list", { name: "조건" })).toHaveText("일봉최근20일 이내에고가60일 신고가인 봉이 있다");
    await expect(panel(page).getByText("ETF", { exact: true })).toBeVisible();
    await expect(panel(page).getByText("저장 전에도 실행할 수 있습니다")).toBeVisible();
  });

  await test.step("실행", async () => {
    await runButton(page).click();
    await expect(results(page)).toContainText("4종목 · 11-06(금) 기준");
    await expect(results(page)).toContainText("대상 9종목 · 빠짐: 상장 기간 부족 1 · 이력 덜 참 0");
    await expect(results(page).getByRole("columnheader", { name: "충족일 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", "descending");
    await expectRows(page, [
      ["110030", "가상분할", "당일"],
      ["110035", "가상전자우", "당일"],
      ["110040", "가상정지", "10-23"],
      ["110050", "가상관리", "10-19"],
    ]);
    await expect(rail(page).getByRole("tab", { name: /^스크리너/ })).toContainText("결과 4종목");
  });

  await test.step("지수 칸에서 행을 누르면 그 종목을 통합으로 연다", async () => {
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 일");
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상분할 통합 일");
    expect(barRequests).toContain("110030:combined:D");
    expect(barRequests.filter((r) => r.endsWith(":krx:D"))).toEqual([]);
  });

  await test.step("↑↓로 결과를 차례로 열고, 빨리 두 번 누르면 두 칸 간다", async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expectCellOn(page, rows(page).nth(2), "가상정지 통합 일");
    await page.keyboard.press("ArrowUp");
    await expectCellOn(page, rows(page).nth(1), "가상전자우 통합 일");
  });

  await test.step("행을 열면 칸의 종목만 바뀌고, 봉 주기와 거래소는 그대로이며, NXT가 없는 종목이면 NXT 칸이 통합이 된다", async () => {
    await pickPeriod(page, "주");
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상분할 통합 주");
    await pickVenue(page, "NXT");
    await expectCellOn(page, rows(page).nth(0), "가상분할 NXT 주");
    await rows(page).nth(3).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(3), "가상관리 NXT 주");
    expect(barRequests).toContain("110050:nxt:W");
    await rows(page).nth(1).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(1), "가상전자우 통합 주");
    await pickVenue(page, "KRX");
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상분할 KRX 주");
  });

  await test.step("결과를 새 관심종목 목록으로 보낸다", async () => {
    const saved = Promise.all([savedTo(page, "/api/watchlists"), savedTo(page, "/api/ui-state")]);
    await panel(page).getByRole("button", { name: "스크리너 메뉴" }).click();
    const menu = page.getByRole("menu", { name: "스크리너 메뉴" });
    await expect(menu.getByText("결과 4종목을 관심종목으로 보내기")).toBeVisible();
    await menu.getByRole("menuitem", { name: `새 목록 "${SCREEN_NAME}"` }).click();
    await expect(page.getByText(`${SCREEN_NAME}에 4종목을 넣었습니다`)).toBeVisible();
    await saved;
    await rail(page).getByRole("tab", { name: "관심종목" }).click();
    await expectWatchlistOfResults(page);
  });

  await test.step("다음 날 아침에는 자료가 모자라 실행이 막히고, 업데이트하면 다시 실행된다", async () => {
    screener.showStatus({ ...readyStatus(), needDay: "2026-11-09", todayAvailable: false });
    screener.updateTo({ ...readyStatus(), lastDay: "2026-11-09", needDay: "2026-11-09" });
    screener.showResult({ ...highResult(), asOf: "2026-11-09", rows: highResult().rows.map(row => ({ ...row, matchedDate: row.matchedDate === "2026-11-06" ? "2026-11-09" : row.matchedDate })) });
    await page.reload();
    await expectWatchlistOfResults(page);
    await openScreener(page);
    await expect(updateBand(page)).toContainText("자료가 모자랍니다");
    await expect(updateBand(page)).toContainText("11-06(금)까지 있습니다. 실행하려면 11-09(월) 자료가 있어야 합니다. 당일 봉은 20:00 뒤에 받습니다.");
    await expect(runButton(page)).toBeDisabled();
    await expect(panel(page).getByText("자료 상태를 확인한 뒤 실행하세요")).toBeVisible();
    await expect(panel(page).getByText("새 자료가 필요합니다")).toBeVisible();

    await updateBand(page).getByRole("button", { name: "업데이트" }).click();
    await waitForUpdateToFinish(page, "11-09(월)");
    await page.reload();
    await openScreener(page);
    await runButton(page).click();
    await expect(results(page)).toContainText("4종목 · 11-09(월) 기준");
  });

  await test.step("조건식을 고치면 고친 조건으로 실행된다", async () => {
    await expandEditor(page);
    const dialog = editor(page, "조건식 편집");
    await renameScreen(dialog, EDITED_NAME);
    await toggleExclude(dialog, "상태", "거래정지");
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await savedEditor(dialog);
    await expect(screenChooser(page)).toHaveText(EDITED_NAME);
    await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
    screener.showResult(resultRows([["110030", "가상분할", "당일"], ["110035", "가상전자우", "당일"], ["110050", "가상관리", "10-19"]], { asOf: "2026-11-09", universe: 8, excluded: { listedTooShort: 1, historyShort: 0, unconfirmed: 0 } }));
    await runButton(page).click();
    await expect(results(page)).toContainText("3종목 · 11-09(월) 기준");
    await expect(results(page)).toContainText("대상 8종목");
    await expectRows(page, [
      ["110030", "가상분할", "당일"],
      ["110035", "가상전자우", "당일"],
      ["110050", "가상관리", "10-19"],
    ]);
  });

  await test.step("조건식을 확인받고 지운다", async () => {
    await page.reload();
    await openScreener(page);
    await expect(screenChooser(page)).toHaveText(EDITED_NAME);
    await expandEditor(page);
    const dialog = editor(page, "조건식 편집");
    const saved = savedTo(page, "/api/screens");
    await screenAction(dialog, "지우기");
    const confirmation = page.getByRole("dialog", { name: `"${EDITED_NAME}" 조건식을 삭제할까요? 되돌릴 수 없습니다.` });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "조건식 지우기", exact: true }).click();
    await saved;
    await expect(dialog).toBeHidden();
    await expect(panel(page).getByText("저장한 조건식이 없습니다")).toBeVisible();
    await page.reload();
    await openScreener(page);
    await expect(panel(page).getByText("저장한 조건식이 없습니다")).toBeVisible();
  });
});

test("시가총액 줄이나 줄마다 다른 봉 주기가 든 조건식도 편집에서 그대로 열리고, 이름만 바꿔 저장해도 줄과 시장이 그대로 남으며, 거래대금 신고가 줄은 신고거래대금 항목으로 보인다", async ({ scenario, page }) => {
  const newHigh = (period: "D" | "W" | "M", field: "close" | "high" | "volume" | "traded_value", n: number, m: number): Condition => ({ kind: "new_high", period, recentBars: m, field, n });
  const capped: Screen = { id: "capped", name: "시가총액 섞임", markets: [], exclude: [], conditions: [newHigh("D", "high", 60, 1), { kind: "market_cap", min: 300_000_000_000, max: null }] };
  const mixed: Screen = { id: "mixed", name: "주봉 섞임", markets: ["kosdaq"], exclude: [], conditions: [newHigh("D", "high", 60, 1), newHigh("W", "close", 52, 1)] };
  const traded: Screen = { id: "traded", name: "신고거래대금", markets: [], exclude: [], conditions: [newHigh("D", "traded_value", 60, 1)] };
  scenario.documents.saveScreens({ screens: [capped, mixed, traded], revision: 1 });
  await page.goto("/");
  await openScreener(page);
  const edit = async (name: string) => {
    await screenChooser(page).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
    await expect(screenChooser(page)).toHaveText(name);
    await expandEditor(page);
    const dialog = editor(page, "조건식 편집");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    return dialog;
  };
  const renameAndSave = async (dialog: Locator, name: string) => {
    await renameScreen(dialog, name);
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await savedEditor(dialog);
  };

  await test.step("시가총액 줄은 봉 주기 없이 억 원으로 보이고, 이름만 바꿔 저장된다", async () => {
    const dialog = await edit(capped.name);
    await expectKind(dialog, 2, "market_cap");
    await expect(dialog.getByRole("combobox", { name: "조건 2 봉 주기" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "조건 2 최소" })).toHaveText("3000");
    await expect(dialog.getByText("시가총액이3000억 원이상이다")).toBeVisible();
    await renameAndSave(dialog, "시가총액 섞임 바꿈");
  });

  await test.step("줄마다 다른 봉 주기와 고른 시장이 보이고, 이름만 바꿔 저장된다", async () => {
    const dialog = await edit(mixed.name);
    await expect(dialog.getByRole("combobox", { name: "조건 1 봉 주기" })).toHaveAttribute("data-value", "D");
    await expect(dialog.getByRole("combobox", { name: "조건 2 봉 주기" })).toHaveAttribute("data-value", "W");
    await expect(dialog.getByText("주봉최근1주 이내에종가52주 신고가인 봉이 있다")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스피" })).toHaveAttribute("aria-pressed", "false");
    await renameAndSave(dialog, "주봉 섞임 바꿈");
  });

  await test.step("거래대금 신고가 줄은 종류 칸에 신고거래대금이 골라져 있고 기간이 그대로이며, 이름을 바꿔 저장해도 거래대금이다", async () => {
    const dialog = await edit(traded.name);
    await expectKind(dialog, 1, "traded_value_high");
    await expect(dialog.getByRole("button", { name: "조건 1 신고거래대금 기간" })).toHaveText("60");
    await expect(dialog.getByRole("button", { name: "조건 1 최근 기간" })).toHaveText("1");
    await expect(dialog.getByText("일봉최근1일 이내에60일 신고거래대금인 봉이 있다")).toBeVisible();
    await renameAndSave(dialog, "신고거래대금 바꿈");
  });

  const stored = scenario.documents.screens();
  expect(stored.screens).toEqual([
    { ...capped, name: "시가총액 섞임 바꿈" },
    { ...mixed, name: "주봉 섞임 바꿈" },
    { ...traded, name: "신고거래대금 바꿈" },
  ]);
});

test("패널 머리는 줄마다 그 줄의 봉 주기로 조건을 풀고, 시장 칩을 제외 칩과 함께 보이며, 조건식 메뉴에는 이름만 보인다", async ({ scenario, page }) => {
  const newHigh = (period: "D" | "W" | "M", field: "close" | "high" | "volume" | "traded_value", n: number, m: number): Condition => ({ kind: "new_high", period, recentBars: m, field, n });
  const mixed: Screen = { id: "mixed", name: "주봉 신고가와 일봉 신고거래량", markets: ["kosdaq"], exclude: ["managed", "etf"], conditions: [newHigh("W", "close", 52, 1), newHigh("D", "volume", 60, 5)] };
  const plain: Screen = { id: "plain", name: "전 종목 신고가", markets: [], exclude: [], conditions: [newHigh("M", "high", 12, 1)] };
  scenario.documents.saveScreens({ screens: [mixed, plain], revision: 1 });
  await page.goto("/");
  await openScreener(page);
  await expandEditor(page);

  const conditions = panel(page).getByRole("list", { name: "조건" });
  const markets = panel(page).getByRole("group", { name: "대상 시장", exact: true });
  const selectedMarkets = markets.locator('button[aria-pressed="true"]');
  const exclusions = panel(page).getByRole("button", { name: / 제외 해제$/ });
  await expect(screenChooser(page)).toHaveText(mixed.name);
  await expect(conditions.getByRole("listitem")).toHaveText(["주봉최근1주 이내에종가52주 신고가인 봉이 있다", "그리고일봉최근5일 이내에60일 신고거래량인 봉이 있다"]);
  await expect(selectedMarkets).toHaveText(["코스닥"]);
  await expect(exclusions).toHaveText(["ETF", "관리종목"]);
  await expect(markets.getByRole("button", { name: "코스닥", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page).getByRole("button", { name: "ETF 제외 해제", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "관리종목 제외 해제", exact: true })).toBeVisible();

  await screenChooser(page).click();
  await expect(page.getByRole("menu", { name: "조건식 고르기" }).getByRole("menuitemradio")).toHaveText([mixed.name, plain.name]);
  await page.getByRole("menuitemradio", { name: plain.name, exact: true }).click();
  await expect(conditions).toHaveText("월봉최근1개월 이내에고가12개월 신고가인 봉이 있다");
  await expect(markets.getByText("두 시장 모두", { exact: true })).toBeVisible();
  await expect(selectedMarkets).toHaveCount(0);
  await expect(exclusions).toHaveCount(0);
});

test("결과를 연 뒤 종목 정보를 기다리는 사이 검색으로 다른 종목을 열면, 늦게 온 정보는 그 선택을 덮지 않고 다음 열기는 그대로 된다", async ({ scenario, page }) => {
  await runSeededScreen(scenario, page, openScreener);
  const held = await holdSymbolInfo(scenario, page, "110030");
  await rows(page).nth(0).getByRole("button").click();
  await held.requested;

  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const search = page.getByRole("dialog", { name: "종목 검색" });
  await search.getByRole("combobox", { name: "종목 검색" }).fill("110050");
  await search.getByRole("option").filter({ hasText: "110050" }).click();
  await expectCellOn(page, rows(page).nth(3), "가상관리 통합 일");

  await held.release();
  await expectCellOn(page, rows(page).nth(3), "가상관리 통합 일");
  await rows(page).nth(1).getByRole("button").click();
  await expectCellOn(page, rows(page).nth(1), "가상전자우 통합 일");
});

test.describe("20:00 뒤", () => {
  test("오늘 자료를 받는 안내와 완료 날짜를 보이고, 다음 관측일이 있으면 업데이트를 제안한다", async ({ screener, page }) => {
    const previous = { ...readyStatus(), lastDay: "2026-11-05", needDay: "2026-11-04", todayAvailable: false };
    screener.updateTo({ ...previous, update: { phase: "backfill", done: 2, total: 10, error: null, full: false } });
    await page.goto("/");
    await openScreener(page);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await expect(panel(page).getByRole("status")).toContainText(/과거 이력 이어 받기[\s\S]*오늘 자료까지 받습니다\./);
    screener.showStatus(previous);
    await waitForUpdateToFinish(page, "11-05(목)");
    await expect(storeLine(page)).toContainText("빠진 관측일 없음");
    screener.showStatus({ ...previous, needDay: "2026-11-05", todayAvailable: true });
    screener.updateTo(readyStatus());
    await page.reload();
    await openScreener(page);
    await expect(storeLine(page)).toContainText("KRX 일봉 · 11-05(목)까지");
    await expect(storeLine(page)).toContainText("오늘 자료를 받을 수 있습니다");
    await storeLine(page).getByRole("button", { name: "업데이트" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await expect(storeLine(page)).toContainText("빠진 관측일 없음");
  });
});

test("최근 관측일 수집 중 실행을 막고 이력 이어 받기 취소와 완료 상태의 제외 종목 안내와 결과를 표시한다", async ({ screener, page }) => {
  await page.goto("/");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식" }).click();
  const dialog = editor(page, "새 조건식");
  await renameScreen(dialog, "고가 1000일 신고가");
  await addCondition(dialog);
  await fillNumber(dialog.getByRole("button", { name: "조건 1 신고가 기간" }), "1000");
  await fillNumber(dialog.getByRole("button", { name: "조건 1 최근 기간" }), "300");
  await dialog.getByRole("button", { name: "저장" }).click();
  await savedEditor(dialog);

  screener.updateTo({ ...emptyStatus(), update: { phase: "recent", done: 0, total: 10, error: null, full: false } });
  const partial = { ...readyStatus(), fullHistory: { done: 2, total: 10 } };
  screener.cancelTo(partial);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await expect(updateBand(page)).toContainText("최근 관측일 채우기");
  await expect(runButton(page)).toBeDisabled();
  await expect(panel(page).getByText("자료 상태를 확인한 뒤 실행하세요")).toBeVisible();

  screener.showStatus({ ...partial, update: { phase: "backfill", done: 2, total: 10, error: null, full: false } });
  await expect(updateBand(page)).toContainText("과거 이력 이어 받기");
  await updateBand(page).getByRole("button", { name: "취소" }).click();
  screener.showResult(resultRows([], { universe: 10, excluded: { listedTooShort: 6, historyShort: 2, unconfirmed: 0 } }));
  await runButton(page).click();
  await expect(excludedLine(page)).toHaveText(/^대상 10종목 · 빠짐: 상장 기간 부족 6 · 이력 덜 참 [1-4]$/);
  await expect(updateBand(page)).toBeHidden();
  await expect(storeLine(page)).toContainText(/과거 이력 \d\/10종목/);

  screener.updateTo(readyStatus());
  screener.showResult(resultRows([["110060", "가상200", "09-30"], ["110010", "가상전자", "08-03"], ["110020", "가상화학", "07-14"]], { universe: 10, excluded: { listedTooShort: 6, historyShort: 0, unconfirmed: 0 } }));
  await storeLine(page).getByRole("button", { name: "업데이트" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await expect(storeLine(page)).not.toContainText("과거 이력");
  await results(page).getByRole("button", { name: "새 자료로 다시 실행" }).click();
  await expect(excludedLine(page)).toHaveText("대상 10종목 · 빠짐: 상장 기간 부족 6 · 이력 덜 참 0");
  await expectRows(page, [
    ["110060", "가상200", "09-30"],
    ["110010", "가상전자", "08-03"],
    ["110020", "가상화학", "07-14"],
  ]);
});

test("운영자 확인이 필요한 업데이트 오류는 이유만 보이고 다시 시도를 숨기며 새 현황에서는 처음 받기를 표시한다", async ({ screener, page }) => {
  screener.updateTo({ ...emptyStatus(), update: { phase: "recent", done: 0, total: 10, full: false, error: { ...runError("키움 응답 형식이 예상과 다릅니다. 운영자가 확인하고 서버를 다시 켤 때까지 요청을 멈춥니다", "protocol").error, manualActionRequired: true } } });
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  const stopped = panel(page).getByRole("alert");
  await expect(stopped).toContainText("업데이트가 멈췄습니다");
  await expect(stopped).toContainText("최근 관측일 채우기 0/10종목에서 멈춤: 키움 응답 형식이 예상과 다릅니다");
  await expect(stopped).toContainText("운영자가 확인하고 서버를 다시 켤 때까지");
  await expect(stopped.getByRole("button", { name: "다시 시도" })).toHaveCount(0);

  screener.showStatus(emptyStatus());
  screener.updateTo(readyStatus());
  await page.reload();
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
});

test.describe("서버와 시계가 어긋난 브라우저", () => {
  const kstClock = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hourCycle: "h23" });
  const retryButton = (page: Page) => panel(page).getByRole("alert").getByRole("button", { name: "다시 시도" });
  const stopped = (retryAt: number): ScreenerStatus => ({ ...emptyStatus(), update: { phase: "recent", done: 0, total: 10, full: false, error: { ...runError("키움에 연결하지 못했습니다", "kiwoom_unreachable").error, retryAt } } });

  async function expectFullReload(page: Page, check: (item: Locator) => Promise<void>) {
    const toggle = panel(page).getByRole("button", { name: "스크리너 메뉴" });
    const menu = page.getByRole("menu", { name: "스크리너 메뉴" });
    await toggle.click();
    await check(menu.getByRole("menuitem", { name: /^전체 다시 받기/ }));
    await toggle.click();
    await expect(menu).toBeHidden();
  }

  test("서버가 안내한 재시도 시각까지 브라우저 시계가 앞서거나 뒤처져도 다시 시도와 전체 다시 받기를 막는다", async ({ scenario, screener, page, browser }) => {
    const ahead = page;
    const retryAt = Math.floor(scenario.now / 1000) + 30;
    screener.updateTo(stopped(retryAt));
    await ahead.clock.install({ time: scenario.now + 60_000 });
    await ahead.goto("/");
    await openScreener(ahead);
    await updateBand(ahead).getByRole("button", { name: "처음 받기" }).click();
    const behindContext = await browser.newContext();
    await scenario.install(behindContext);
    const behind = await behindContext.newPage();
    await behind.clock.install({ time: scenario.now - 60_000 });
    await behind.goto(ahead.url());
    await openScreener(behind);
    const opensFrom = `${kstClock(retryAt + 1)}부터`;
    for (const p of [ahead, behind]) {
      await expect(retryButton(p)).toBeDisabled();
      await expect(panel(p).getByRole("alert")).toContainText(`${opensFrom} 다시 시도할 수 있습니다.`);
      await expectFullReload(p, async item => { await expect(item).toBeDisabled(); await expect(item).toContainText(opensFrom); });
    }
    await ahead.clock.setSystemTime(scenario.now);
    const answered = ahead.waitForResponse(response => new URL(response.url()).pathname === "/api/symbols");
    await ahead.getByTitle(SEARCH_BUTTON_TITLE).click();
    await ahead.getByRole("dialog", { name: "종목 검색" }).getByRole("combobox", { name: "종목 검색" }).fill("삼성");
    await answered;
    await ahead.keyboard.press("Escape");
    for (const p of [ahead, behind]) {
      await p.clock.fastForward(20_000);
      await expect(retryButton(p)).toBeDisabled();
      await p.clock.fastForward(12_000);
      await expect(retryButton(p)).toBeEnabled();
      await expect(panel(p).getByRole("alert")).toContainText("다시 시도하면 남은 것만 받습니다.");
      await expectFullReload(p, async item => { await expect(item).toBeEnabled(); await expect(item).toHaveText("전체 다시 받기…"); });
    }
    screener.updateTo(readyStatus());
    const requested = ahead.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/screener/update");
    await retryButton(ahead).click();
    expect((await requested).postDataJSON()).toEqual({ full: false });
    await waitForUpdateToFinish(ahead, "11-06(금)");
    await behindContext.close();
  });

  test("오래된 봉 응답이 늦게 와도 안내한 재시도 시각은 바뀌지 않는다", async ({ scenario, screener, page }) => {
    const retryAt = Math.floor(scenario.now / 1000) + 30;
    screener.updateTo(stopped(retryAt));
    let holding = true;
    const held = scenario.hold(url => url.pathname === "/api/bars" && holding);
    await page.clock.install({ time: scenario.now });
    await page.goto("/");
    const request = await held.received;
    holding = false;
    const query = new URL(request.url()).searchParams;
    const oldBars = scenario.market.page({ symbol: query.get("symbol") ?? "IDX:001" });
    await openScreener(page);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await expect(retryButton(page)).toBeDisabled();
    await expectFullReload(page, async item => { await expect(item).toBeDisabled(); await expect(item).toContainText(`${kstClock(retryAt + 1)}부터`); });
    await page.clock.fastForward(20_000);
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/bars");
    held.reply({ body: oldBars });
    await delivered;
    await expect(retryButton(page)).toBeDisabled();
    await page.clock.fastForward(12_000);
    await expect(retryButton(page)).toBeEnabled();
    await expectFullReload(page, async item => { await expect(item).toBeEnabled(); await expect(item).toHaveText("전체 다시 받기…"); });
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("스크리너 탭에서 찾은 행을 누르면 차트 탭으로 가서 칸의 종목만 바꾼다", async ({ scenario, page }) => {
    await runSeededScreen(scenario, page, openPhoneScreener);
    await rows(page).nth(1).getByRole("button").click();
    await expect(phoneTabs(page).getByRole("button", { name: "차트" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page)).toBeHidden();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자우 통합 일");
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  });

  test("행을 누른 뒤 종목 정보를 기다리는 사이 다른 탭으로 가면, 늦게 온 정보는 차트 탭으로 끌고 가지 않고 칸도 바꾸지 않는다", async ({ scenario, page }) => {
    await runSeededScreen(scenario, page, openPhoneScreener);
    const held = await holdSymbolInfo(scenario, page, "110030");
    await rows(page).nth(0).getByRole("button").click();
    await held.requested;
    await phoneTabs(page).getByRole("button", { name: "관심종목" }).click();
    await expect(phoneTabs(page).getByRole("button", { name: "관심종목" })).toHaveAttribute("aria-pressed", "true");

    await held.release();
    await expect(phoneTabs(page).getByRole("button", { name: "관심종목" })).toHaveAttribute("aria-pressed", "true");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 일");

    await openPhoneScreener(page);
    await rows(page).nth(1).getByRole("button").click();
    await expect(phoneTabs(page).getByRole("button", { name: "차트" })).toHaveAttribute("aria-pressed", "true");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자우 통합 일");
  });
});

for (const width of [320, 360]) {
  test.describe(`좁은 휴대폰 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("편집 대화상자는 모든 종류와 판정에서 모든 칸이 가로 스크롤 없이 화면 안에 보인다", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click();
      await panel(page).getByRole("button", { name: "새 조건식" }).first().click();
      const dialog = editor(page, "새 조건식");
      const pick = (name: string, value: string) => selectOption(dialog.getByRole("combobox", { name: `조건 1 ${name}` }), value);
      await dialog.getByRole("button", { name: "조건 더하기" }).click();
      const variants: readonly (readonly [kind: string, choices?: readonly (readonly [name: string, value: string])[], more?: number])[] = [
        ["new_high"],
        ["new_low"],
        ["value_range"],
        ["change"],
        ["near_extreme"],
        ["volume_high"],
        ["traded_value_high"],
        ["surge"],
        ["ma_position"],
        ["ma_alignment", [], 1],
        ["ma_cross", [["짧은 선", "ma"]]],
        ["ma_cross", [["짧은 선", "close"]]],
        ["rsi", [["판정", "range"]]],
        ["rsi", [["판정", "breakout"]]],
        ["macd", [["판정", "signal_cross"]]],
        ["macd", [["판정", "zero_breakout"]]],
        ["macd", [["판정", "vs_signal"]]],
        ["stochastic", [["판정", "cross"]]],
        ["stochastic", [["판정", "range"]]],
        ["bollinger", [["판정", "outside"]]],
        ["bollinger", [["판정", "cross"]]],
        ["ichimoku", [["판정", "cloud"]]],
        ["ichimoku", [["판정", "cross"]]],
        ["market_cap"],
      ];
      await pick("봉 주기", "M");
      for (const [kind, choices = [], more = 0] of variants) {
        await pick("종류", kind);
        for (const [name, value] of choices) await pick(name, value);
        for (let i = 0; i < more; i++) await dialog.getByRole("button", { name: "조건 1 이평 더하기" }).click();
        const layout = await dialog.evaluate((d) => ({
          cut: [...d.querySelectorAll("input, select, button")]
            .filter((c) => {
              const box = c.getBoundingClientRect();
              return box.left < 0 || box.right > window.innerWidth;
            })
            .map((c) => c.getAttribute("aria-label") ?? c.textContent),
          scrolling: [d, ...d.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth && ["auto", "scroll"].includes(getComputedStyle(e).overflowX)).length,
        }));
        expect({ kind, choices, ...layout }).toEqual({ kind, choices, cut: [], scrolling: 0 });
      }
      await expect(dialog.getByRole("textbox", { name: "조건 1 최대" })).toBeVisible();
    });
  });
}
