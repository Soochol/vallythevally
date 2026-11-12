import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./harness";
import { editor, excludedLine, expectRows, openScreener, panel, results, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

const NO_CONDITIONS = "조건 없음 · 대상 종목 전체";
const SCREEN_NAME = "조건 없는 대상 종목";
const NEW_HIGH = "일봉 0봉 전 고가가 200일 신고가다";

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
const lineTexts = (dialog: Locator) => conditionList(dialog).getByRole("listitem").locator(":scope > p");
const addLine = (dialog: Locator) => dialog.getByRole("button", { name: "조건 더하기" });
const removeLine = (dialog: Locator, line: number) => dialog.getByRole("button", { name: `조건 ${line} 빼기` });
const marketChip = (dialog: Locator, name: string) => dialog.getByRole("group", { name: "시장" }).getByRole("button", { name });
const statusChip = (dialog: Locator, name: string) => dialog.getByRole("group", { name: "상태 제외" }).getByRole("button", { name });
const asOfToday = (codes: readonly string[]) => EVERY_STOCK.filter(([code]) => codes.includes(code)).map(([code, name]) => [code, name, "당일"] as const);

async function expectNoConditions(scope: Locator) {
  await expect(scope.getByText(NO_CONDITIONS, { exact: true })).toBeVisible();
  await expect(conditionList(scope)).toHaveCount(0);
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await expect(dialog).toBeHidden();
}

async function editScreen(page: Page) {
  await panel(page).getByRole("button", { name: "편집" }).click();
  return editor(page, "조건식 편집");
}

async function runAndExpect(page: Page, excluded: string, expected: readonly (readonly [code: string, name: string, matchedDate: string])[]) {
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
  await expect(results(page)).toContainText(`${expected.length}종목 · 11-06(금) 기준`);
  await expect(excludedLine(page)).toHaveText(excluded);
  await expectRows(page, expected);
}

test("새 조건식은 조건 없이 열리고 마지막 줄까지 뺐다가 다시 더할 수 있으며, 조건 없이 저장한 조건식은 다시 열어도 비어 있고, 실행하면 시장·제외 설정에 맞는 대상 종목 전체가 기준 관측일에 맞은 것으로 나온다", async ({ app, page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");

  await test.step("새 조건식은 조건 0줄로 열리고, 마지막 줄을 빼면 다시 비며, 빈 상태에서 다시 더할 수 있다", async () => {
    await panel(page).getByRole("button", { name: "새 조건식" }).click();
    const dialog = editor(page, "새 조건식");
    await expectNoConditions(dialog);
    await expect(dialog).toContainText("조건을 모두 만족하는 종목만 찾습니다 · 0/10줄");

    await addLine(dialog).click();
    await addLine(dialog).click();
    await expect(lineTexts(dialog)).toHaveText([NEW_HIGH, NEW_HIGH]);
    await removeLine(dialog, 2).click();
    await expect(lineTexts(dialog)).toHaveText([NEW_HIGH]);
    await expect(removeLine(dialog, 1)).toBeEnabled();
    await removeLine(dialog, 1).click();
    await expectNoConditions(dialog);
    await expect(dialog).toContainText("0/10줄");

    await addLine(dialog).click();
    await expect(lineTexts(dialog)).toHaveText([NEW_HIGH]);
    await expect(dialog.getByText(NO_CONDITIONS, { exact: true })).toHaveCount(0);
    await removeLine(dialog, 1).click();
    await expectNoConditions(dialog);
  });

  await test.step("조건 없이 이름만 넣어 저장하면 패널에 '조건 없음 · 대상 종목 전체'가 보이고, 서버에는 조건 0줄로 남는다", async () => {
    const dialog = editor(page, "새 조건식");
    await dialog.getByLabel("이름").fill(SCREEN_NAME);
    await save(page, dialog);
    await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
    await expectNoConditions(panel(page));
    await expect(panel(page).getByText("전 종목 대상")).toBeVisible();
    const stored = await (await fetch(`${app.url}/api/screens`)).json();
    expect(stored.screens).toEqual([{ id: expect.any(String), name: SCREEN_NAME, markets: [], exclude: [], conditions: [] }]);
  });

  await test.step("실행하면 시장도 제외도 고르지 않은 대상 종목 전체가 기준 관측일인 당일로 나온다", async () => {
    await runAndExpect(page, "대상 10종목 · 빠짐: 상장 기간 부족 0 · 이력 덜 참 0", asOfToday(EVERY_STOCK.map(([code]) => code)));
  });

  await test.step("다시 열어도 조건이 없고, 코스닥과 관리종목 제외를 골라 저장한 뒤 새로 고쳐 다시 열어도 그대로다", async () => {
    let dialog = await editScreen(page);
    await expect(dialog.getByLabel("이름")).toHaveValue(SCREEN_NAME);
    await expectNoConditions(dialog);
    await marketChip(dialog, "코스닥").click();
    await statusChip(dialog, "관리종목").click();
    await save(page, dialog);
    await expectNoConditions(panel(page));

    await page.reload();
    await openScreener(page);
    await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
    await expectNoConditions(panel(page));
    await expect(panel(page).getByText("코스닥", { exact: true })).toBeVisible();
    await expect(panel(page).getByText("관리종목", { exact: true })).toBeVisible();
    dialog = await editScreen(page);
    await expectNoConditions(dialog);
    await expect(marketChip(dialog, "코스닥")).toHaveAttribute("aria-pressed", "true");
    await expect(statusChip(dialog, "관리종목")).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "취소" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("실행하면 코스닥에서 관리종목을 뺀 대상 종목 전체가 당일로 나온다", async () => {
    await runAndExpect(page, "대상 3종목 · 빠짐: 상장 기간 부족 0 · 이력 덜 참 0", asOfToday(KOSDAQ_WITHOUT_MANAGED));
  });
});
