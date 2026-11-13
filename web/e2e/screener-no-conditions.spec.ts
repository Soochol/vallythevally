import { resultRows, type ScreenerScenario } from "./fixtures/screener";
import { expectSentences, renameScreen, expandEditor, savedEditor, addCondition, conditionAction, toggleExclude } from "./sentence-editor";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./screener-harness";
import { editor, excludedLine, expectRows, openScreener, panel, results, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";


const NO_CONDITIONS = "조건 없음 · 대상 종목 전체";
const SCREEN_NAME = "조건 없는 대상 종목";
const NEW_HIGH = "일봉최근1일 이내에고가200일 신고가인 봉이 있다";

const EVERY_STOCK = [
  ["110010", "가상전자"],
  ["110020", "가상화학"],
  ["110030", "가상분할"],
  ["110035", "가상전자우"],
  ["110040", "가상정지"],
  ["110050", "가상관리"],
  ["110060", "가상200"],
  ["110070", "가상리츠"],
  ["110080", "가상기업인수목적1호"],
  ["110090", "가상신규"],
] as const;
const KOSDAQ_WITHOUT_MANAGED = ["110030", "110040", "110080"];

const conditionList = (scope: Locator) => scope.getByRole("list", { name: "조건" });
const marketChip = (dialog: Locator, name: string) => dialog.getByRole("group", { name: "대상 시장" }).getByRole("button", { name });
const statusChip = (dialog: Locator, name: string) => dialog.getByRole("group", { name: "상태 제외" }).getByRole("button", { name: `${name} 제외 해제`, exact: true });
const asOfToday = (codes: readonly string[]) => EVERY_STOCK.filter(([code]) => codes.includes(code)).map(([code, name]) => [code, name, "당일"] as const);

async function expectNoConditions(scope: Locator) {
  const fields = scope.getByRole("group", { name: "문장형 조건식", exact: true });
  await expect((await fields.count() ? fields : scope).getByText(NO_CONDITIONS, { exact: true })).toBeVisible();
  await expect(conditionList(scope)).toHaveCount(0);
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await savedEditor(dialog);
}

async function editScreen(page: Page) {
  await expandEditor(page);
  return editor(page, "조건식 편집");
}

async function runAndExpect(page: Page, screener: ScreenerScenario, excluded: string, expected: readonly (readonly [code: string, name: string, matchedDate: string])[]) {
  screener.showResult(resultRows(expected, { universe: expected.length }));
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
  await expect(results(page)).toContainText(`${expected.length}종목 · 11-06(금) 기준`);
  await expect(excludedLine(page)).toHaveText(excluded);
  await expectRows(page, expected);
}

test("새 조건식은 조건 없이 열리고 마지막 줄을 빼고 다시 더하며, 빈 조건과 시장·제외 설정을 저장하고 반환된 대상 종목과 관측일을 표시한다", async ({ scenario, screener, page }) => {
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");

  await test.step("새 조건식은 조건 0줄로 열리고, 마지막 줄을 빼면 다시 비며, 빈 상태에서 다시 더할 수 있다", async () => {
    await panel(page).getByRole("button", { name: "새 조건식" }).click();
    const dialog = editor(page, "새 조건식");
    await expectNoConditions(dialog);
    await expect(dialog).toContainText("모든 조건 충족 · 0/10줄");

    await addCondition(dialog);
    await addCondition(dialog);
    await expectSentences(dialog, [NEW_HIGH, NEW_HIGH]);
    await conditionAction(dialog, 2, "조건 지우기");
    await expectSentences(dialog, [NEW_HIGH]);
    await dialog.getByRole("button", { name: "조건 1 메뉴", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "조건 지우기", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await conditionAction(dialog, 1, "조건 지우기");
    await expectNoConditions(dialog);
    await expect(dialog).toContainText("0/10줄");

    await addCondition(dialog);
    await expectSentences(dialog, [NEW_HIGH]);
    await expect(dialog.getByText(NO_CONDITIONS, { exact: true })).toHaveCount(0);
    await conditionAction(dialog, 1, "조건 지우기");
    await expectNoConditions(dialog);
  });

  await test.step("조건 없이 이름만 넣어 저장하면 패널에 '조건 없음 · 대상 종목 전체'가 보이고, 서버에는 조건 0줄로 남는다", async () => {
    const dialog = editor(page, "새 조건식");
    await renameScreen(dialog, SCREEN_NAME);
    await save(page, dialog);
    await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(SCREEN_NAME);
    await expectNoConditions(panel(page));
    await expect(panel(page).getByText("두 시장 모두")).toBeVisible();
    await expect(panel(page).getByRole("group", { name: "대상 시장", exact: true }).locator('button[aria-pressed="true"]')).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: / 제외 해제$/ })).toHaveCount(0);
    const stored = scenario.documents.screens();
    expect(stored.screens).toEqual([{ id: expect.any(String), name: SCREEN_NAME, markets: [], exclude: [], conditions: [] }]);
  });

  await test.step("실행하면 시장도 제외도 고르지 않은 대상 종목 전체가 기준 관측일인 당일로 나온다", async () => {
    await runAndExpect(page, screener, "대상 10종목 · 빠짐: 상장 기간 부족 0 · 이력 덜 참 0", asOfToday(EVERY_STOCK.map(([code]) => code)));
  });

  await test.step("다시 열어도 조건이 없고, 코스닥과 관리종목 제외를 골라 저장한 뒤 새로 고쳐 다시 열어도 그대로다", async () => {
    let dialog = await editScreen(page);
    await expect(dialog.getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(SCREEN_NAME);
    await expectNoConditions(dialog);
    await marketChip(dialog, "코스닥").click();
    await toggleExclude(dialog, "상태", "관리종목");
    await save(page, dialog);
    await expectNoConditions(panel(page));

    await page.reload();
    await openScreener(page);
    await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(SCREEN_NAME);
    await expectNoConditions(panel(page));
    await expect(panel(page).getByLabel("조건 요약", { exact: true })).toContainText("코스닥 · 관리종목 제외");
    dialog = await editScreen(page);
    await expectNoConditions(dialog);
    await expect(marketChip(dialog, "코스닥")).toHaveAttribute("aria-pressed", "true");
    await expect(statusChip(dialog, "관리종목")).toBeVisible();
    await savedEditor(dialog);
  });

  await test.step("실행하면 코스닥에서 관리종목을 뺀 대상 종목 전체가 당일로 나온다", async () => {
    await runAndExpect(page, screener, "대상 3종목 · 빠짐: 상장 기간 부족 0 · 이력 덜 참 0", asOfToday(KOSDAQ_WITHOUT_MANAGED));
  });
});
