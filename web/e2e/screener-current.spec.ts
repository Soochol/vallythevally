import { currentResult, readyStatus, runError, type ScreenerScenario } from "./fixtures/screener";
import { fillNumber, expandEditor, savedEditor, addCondition, chooseKind } from "./sentence-editor";
import type { Page } from "@playwright/test";
import type { Screen } from "../src/api/generated/Screen";
import type { ScreenerResult } from "../src/api/generated/ScreenerResult";
import { type Scenario, expect, test } from "./screener-harness";
import { selectOption } from "./select-option";
import { editor, openResultDetails, openScreener, panel, results, rowOf, rows, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";


const screen: Screen = { id: "current", name: "최신 자료 확인", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, recentBars: 1 }] };
const meta = (page: Page) => results(page).getByLabel("결과 자료");
test.beforeEach(({ screener }) => { screener.showResult(currentResult()); });

async function prepare(scenario: Scenario, page: Page, open = openScreener) {
  scenario.documents.saveScreens({ screens: [screen], revision: 1 });
  await page.goto("/");
  await open(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
}

async function execute(page: Page): Promise<void> {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const answer = await response;
  expect(answer.status()).toBe(200);
  await expect(results(page)).toHaveAttribute("aria-busy", "false");
  await openResultDetails(page);
}

function intradayResult(baseline: ScreenerResult, price: number, matchedDate = "2026-11-09"): ScreenerResult {
  return { ...baseline, asOf: "2026-11-09", collectionStartedAt: 1794186000, collectionCompletedAt: 1794186001, rows: baseline.rows.map(row => ({ ...row, close: row.symbol === "110010" ? price : row.close, latestBarDate: "2026-11-09", matchedDate, provisional: true })) };
}

async function intraday(screener: ScreenerScenario, page: Page, baseline: ScreenerResult, price: number) {
  screener.showResult(intradayResult(baseline, price));
  await page.reload();
  await openScreener(page);
}

async function editRecent(page: Page, period: string, recent: number) {
  await expandEditor(page);
  const dialog = editor(page, "조건식 편집");
  await selectOption(dialog.getByRole("combobox", { name: "조건 1 봉 주기" }), period);
  await fillNumber(dialog.getByRole("button", { name: "조건 1 최근 기간" }), String(recent));
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  if (await save.isEnabled()) {
    const saved = savedTo(page, "/api/screens");
    await save.click();
    await saved;
  }
  await savedEditor(dialog);
}

test("새 결과는 수동 실행으로만 반영하고 D/W/M 범위 편집·저장 뒤 가격과 잠정을 표시한다", async ({ scenario, screener, page }) => {
  await prepare(scenario, page);
  const baseline = currentResult();
  await execute(page);
  const old = baseline.rows.find((r) => r.symbol === "110010")!;
  await intraday(screener, page, baseline, old.close + 100);
  await execute(page);
  await expect(rowOf(page, "110010")).toContainText((old.close + 100).toLocaleString("ko-KR"));
  await expect(rowOf(page, "110010").getByLabel("잠정", { exact: true })).toBeVisible();
  const before = await rowOf(page, "110010").textContent();
  screener.showResult(intradayResult(baseline, old.close + 200));
  await expect(rowOf(page, "110010")).toHaveText(before!);
  await execute(page);
  await expect(rowOf(page, "110010")).toContainText((old.close + 200).toLocaleString("ko-KR"));
  for (const [period, recent] of [["D", 1], ["W", 2], ["M", 3]] as const) {
    await editRecent(page, period, recent);
    await expect(results(page)).toHaveCount(period === "D" ? 1 : 0);
    screener.showResult(intradayResult(baseline, old.close + 200, period === "M" ? "2026-11-01" : "2026-11-09"));
    await execute(page);
    await expect(rowOf(page, "110010")).toContainText((old.close + 200).toLocaleString("ko-KR"));
    await expect(rowOf(page, "110010").getByLabel("잠정", { exact: true })).toBeVisible();
    await expect(rowOf(page, "110010").getByRole("cell")).toHaveCount(3);
  }
  await editRecent(page, "D", 2);
  await expandEditor(page);
  const dialog = editor(page, "조건식 편집");
  await chooseKind(dialog, 1, "value_range");
  await selectOption(dialog.getByRole("combobox", { name: "조건 1 값" }), "close");
  await fillNumber(dialog.getByRole("button", { name: "조건 1 최소" }), String(old.close));
  await selectOption(dialog.getByRole("combobox", { name: "조건 1 비교" }), "range");
  await fillNumber(dialog.getByRole("button", { name: "조건 1 최대" }), String(old.close));
  await addCondition(dialog);
  await fillNumber(dialog.getByRole("button", { name: "조건 2 신고가 기간" }), "1");
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await saved;
  screener.showResult(intradayResult(baseline, old.close + 200, "2026-11-06"));
  await execute(page);
  await expect(rowOf(page, "110010")).toContainText((old.close + 200).toLocaleString("ko-KR"));
  await expect(rowOf(page, "110010").getByLabel("잠정", { exact: true })).toBeVisible();
  await expect(meta(page)).toContainText("수집 범위 (KST) 2026-11-09 10:");
  await expect(meta(page)).toContainText("기준 관측일 2026-11-09");
});

test("처음 수집 실패는 빈 상태이며 실행 중과 실패 뒤에는 이전 결과와 원래 수집 범위를 보존한다", async ({ scenario, screener, page }) => {
  await prepare(scenario, page);
  screener.failRun();
  await runButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("결과 없음");
  await expect(results(page)).toHaveCount(0);
  screener.showResult(currentResult());
  await execute(page);
  const original = await meta(page).textContent();
  const originalRows = await rows(page).allTextContents();
  const held = scenario.hold("/api/screener/run");
  await runButton(page).click();
  await held.received;
  await expect(results(page)).toHaveAttribute("aria-busy", "true");
  await expect(meta(page)).toHaveText(original!);
  expect(await rows(page).allTextContents()).toEqual(originalRows);
  held.reply({ status: 503, body: runError() });
  await expect(panel(page).getByRole("alert")).toContainText("이전 결과를 그대로 보입니다");
  await expect(meta(page)).toHaveText(original!);
  expect(await rows(page).allTextContents()).toEqual(originalRows);
});

test("개별 누락으로 판정할 수 없는 빈 결과는 조건 불일치와 구분하고 복구 후 수동 실행한다", async ({ scenario, screener, page }) => {
  await prepare(scenario, page);
  const baseline = currentResult();
  await execute(page);
  await intraday(screener, page, baseline, baseline.rows[0]!.close);
  screener.showResult({ ...baseline, missingSummary: 2, rows: baseline.rows.slice(2) });
  await execute(page);
  await expect(rows(page)).toHaveCount(8);
  await expect(meta(page)).toContainText("자료 누락 2종목");
  screener.showResult({ ...baseline, missingSummary: 10, rows: [] });
  await execute(page);
  await expect(meta(page)).toContainText("자료 누락 10종목");
  await expect(results(page)).toContainText("자료 누락 10종목은 판정할 수 없습니다");
  screener.showResult(baseline);
  await execute(page);
  await expect(rows(page)).toHaveCount(10);
});

for (const width of [1440, 1024, 390, 360, 320]) {
  test(`결과 자료와 오래된 최신 봉 날짜가 ${width}px 화면에서 유지된다`, async ({ scenario, page }, info) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    const open = width < 600 ? async (p: Page) => { await p.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click(); } : openScreener;
    await prepare(scenario, page, open);
    await execute(page);
    const halted = currentResult().rows.find((r) => r.symbol === "110040")!;
    await expect(rowOf(page, "110040").getByLabel("잠정", { exact: true })).toHaveCount(0);
    await expect(rowOf(page, "110040").locator(`[title*="최신 일봉 ${halted.latestBarDate}"]`)).toBeVisible();
    await expect(meta(page)).toContainText("수집 범위 (KST)");
    expect(await panel(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await rowOf(page, "110040").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`result-${width}.png`), fullPage: true });
  });
}

test("이전된 조건식은 안내 없이 열리고 편집·저장·새로 고침 뒤에도 범위를 유지한다", async ({ scenario, page }) => {
  scenario.documents.saveScreens({ revision: 12, screens: [{ ...screen, conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, recentBars: 3 }] }] });
  await page.goto("/");
  await openScreener(page);
  await expandEditor(page);
  await expect(panel(page).getByRole("list", { name: "조건" })).toContainText(/최근\s*3일 이내/);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/변환|이전되었습니다|새 규칙으로/)).toHaveCount(0);
  await editRecent(page, "M", 2);
  await page.reload();
  await openScreener(page);
  await expandEditor(page);
  await expect(panel(page).getByRole("list", { name: "조건" })).toContainText(/월봉\s*최근\s*2개월 이내/);
  expect(scenario.documents.screens().revision).toBe(13);
  await expect(page.getByText(/변환|이전되었습니다|새 규칙으로/)).toHaveCount(0);
});

test("서버가 반환한 오래된 관측일과 확정 표시는 유지하고 자료 변경 오류 뒤에는 이전 결과를 보존한다", async ({ scenario, screener, page }) => {
  await prepare(scenario, page);
  await execute(page);
  screener.showStatus(readyStatus());
  await page.reload();
  await openScreener(page);
  await execute(page);
  await expect(meta(page)).toContainText("기준 관측일 2026-11-06");
  await expect(rows(page).getByLabel("잠정", { exact: true })).toHaveCount(0);
  const original = await meta(page).textContent();
  screener.failRun(runError("자료가 바뀌었습니다", "data_changed"), 409);
  const rejected = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const response = await rejected;
  expect(response.status()).toBe(409);
  expect((await response.json()).error.reason).toBe("data_changed");
  await expect(panel(page).getByRole("alert")).toContainText("자료가 바뀌었습니다");
  await expect(meta(page)).toHaveText(original!);
});

test("범위를 바꾸고 다른 화면을 다녀온 최신 결과는 뒤늦은 실패로 바뀌지 않는다", async ({ scenario, screener, page }) => {
  await prepare(scenario, page);
  let holding = true;
  const held = scenario.hold((url) => url.pathname === "/api/screener/run" && holding);
  await runButton(page).click();
  await held.received;
  holding = false;
  screener.showResult(intradayResult(currentResult(), 61_500, "2026-11-01"));
  await editRecent(page, "M", 2);
  await execute(page);
  const newestPrice = rowOf(page, "110010").getByRole("cell").nth(1);
  await expect(newestPrice).toHaveText("61,500*");
  const original = await meta(page).textContent();
  await page.getByRole("tablist", { name: "창 묶음 2" }).getByRole("tab", { name: "관심종목", exact: true }).click();
  await openScreener(page);
  const delivered = page.waitForEvent("requestfinished", (r) => new URL(r.url()).pathname === "/api/screener/run");
  held.reply({ status: 503, body: runError() });
  await delivered;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(meta(page)).toHaveText(original!);
  await expect(newestPrice).toHaveText("61,500*");
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});
