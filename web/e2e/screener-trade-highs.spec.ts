import { expectKind, expectSentences, fillNumber, renameScreen, expandEditor, savedEditor, addCondition, chooseKind } from "./sentence-editor";
import { selectOption } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./harness";
import { editor, excludedLine, expectRows, openScreener, panel, results, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", krxConditionStocks: true, clockStart: "20261106203000" });

const newHigh = (period: string, field: string, n: number, m: number) => ({ kind: "new_high", period, recentBars: m, field, n });
const WEEKLY_HIGH = { id: "plain", name: "주봉 신고가", markets: [], exclude: [], conditions: [newHigh("W", "high", 52, 4)] };
const OLD_VOLUME = { id: "old-volume", name: "신고가 값으로 고른 신고거래량", markets: [], exclude: [], conditions: [newHigh("W", "volume", 52, 4)] };
const RENAMED_OLD = "옛 신고거래량 이름만 바꿈";
const PICKED = "신고거래대금과 주봉 신고거래량";

const OLD_VOLUME_TEXT = "주봉최근4주 이내에52주 신고거래량인 봉이 있다";
const TRADED_START_TEXT = "일봉최근100일 이내에200일 신고거래대금인 봉이 있다";
const VOLUME_START_TEXT = "일봉최근100일 이내에200일 신고거래량인 봉이 있다";
const WEEKLY_VOLUME_TEXT = "주봉최근8주 이내에52주 신고거래량인 봉이 있다";
const MONTHLY_TRADED_TEXT = "월봉최근6개월 이내에24개월 신고거래대금인 봉이 있다";
const MONTHLY_VOLUME_TEXT = "월봉최근3개월 이내에12개월 신고거래량인 봉이 있다";
const EXCLUDED = "대상 16종목 · 빠짐: 상장 기간 부족 2 · 이력 덜 참 0";

const choice = (dialog: Locator, line: number, name: string) => dialog.getByRole("combobox", { name: `조건 ${line} ${name}` });
const box = (dialog: Locator, line: number, name: string) => dialog.getByRole("button", { name: `조건 ${line} ${name}`, exact: true });
async function optionsIn(scope: Locator, group: string) {
  await scope.getByRole("button", { name: "조건 추가", exact: true }).click();
  const popup = scope.page().getByRole("dialog", { name: "조건 추가", exact: true });
  await popup.getByRole("textbox", { name: "조건 종류 검색", exact: true }).fill(group);
  const labels = await popup.getByLabel("조건 종류", { exact: true }).locator("button > span").allTextContents();
  await popup.press("Escape");
  return labels;
}

async function editScreen(page: Page, name: string) {
  await panel(page).getByRole("button", { name: "조건식 고르기", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(name);
  await expandEditor(page);
  return editor(page, "조건식 편집");
}

async function expectTradeHighLine(dialog: Locator, line: number, kind: { value: string; label: string }, period: string, n: string, m: string) {
  await expectKind(dialog, line, kind.value);

  await expect(choice(dialog, line, "봉 주기")).toHaveAttribute("data-value", period);
  await expect(choice(dialog, line, "값")).toHaveCount(0);
  await expect(box(dialog, line, `${kind.label} 기간`)).toHaveText(n);
  await expect(box(dialog, line, "최근 기간")).toHaveText(m);
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await savedEditor(dialog);
}

async function run(page: Page) {
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
}

const VOLUME = { value: "volume_high", label: "신고거래량" };
const TRADED_VALUE = { value: "traded_value_high", label: "신고거래대금" };

test("거래 분류의 신고거래량·신고거래대금은 종류 변경 시 최근 기간을 유지하고, 바꾼 봉 주기와 기간은 저장하고 다시 열어도 남으며, 신고가 값으로 고른 옛 조건식도 그 항목으로 그대로 열리고 실행된다", async ({ app, page }) => {
  test.setTimeout(180_000);
  const screenSaves: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && new URL(req.url()).pathname === "/api/screens") screenSaves.push(req.postData() ?? "");
  });
  const screensUrl = `${app.url}/api/screens`;
  const seeded = await fetch(screensUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [WEEKLY_HIGH, OLD_VOLUME], revision: 1 }) });
  expect(seeded.status).toBe(200);
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");

  await test.step("신고가 값으로 거래량을 골라 둔 옛 조건식은 신고거래량 항목으로 열리고, 열고 닫기만 하면 저장하지 않는다", async () => {
    const dialog = await editScreen(page, OLD_VOLUME.name);
    await expectTradeHighLine(dialog, 1, VOLUME, "W", "52", "4");
    await expectSentences(dialog, [OLD_VOLUME_TEXT]);
    await savedEditor(dialog);
    expect(screenSaves).toEqual([]);
    await expectSentences(panel(page), [OLD_VOLUME_TEXT]);
  });

  await test.step("옛 조건식을 실행하면 이번 주가 52주 최고 거래량인 종목이 이번 주로 나온다", async () => {
    await run(page);
    await expect(results(page)).toContainText("13종목 · 11-06(금) 기준");
    await expect(excludedLine(page)).toHaveText(EXCLUDED);
    await expectRows(page, [
      ["110010", "가상전자", "이번 주"],
      ["110020", "가상화학", "이번 주"],
      ["110030", "가상분할", "이번 주"],
      ["110035", "가상전자우", "이번 주"],
      ["110050", "가상관리", "이번 주"],
      ["110060", "가상200", "이번 주"],
      ["110070", "가상리츠", "이번 주"],
      ["120010", "가상교차급증", "이번 주"],
      ["120020", "가상코스닥교차", "이번 주"],
      ["120030", "가상횡보", "이번 주"],
      ["120040", "가상거래한산", "이번 주"],
      ["120050", "가상전고점", "이번 주"],
      ["120060", "가상시총미달", "이번 주"],
    ]);
  });

  await test.step("옛 조건식의 이름만 바꿔 저장해도 봉 주기와 기간은 그대로다", async () => {
    const dialog = await editScreen(page, OLD_VOLUME.name);
    await renameScreen(dialog, RENAMED_OLD);
    await save(page, dialog);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens).toEqual([WEEKLY_HIGH, { ...OLD_VOLUME, name: RENAMED_OLD }]);
  });

  await test.step("거래 분류에 신고거래량·신고거래대금·거래 급증이 있고, 신고가의 값은 가격만이다", async () => {
    const dialog = await editScreen(page, WEEKLY_HIGH.name);
    expect(await optionsIn(dialog, "거래")).toEqual(["신고거래량", "신고거래대금", "거래 급증"]);
    await choice(dialog, 1, "값").click();
    await expect(page.getByRole("menu", { name: "조건 1 값", exact: true }).getByRole("menuitemradio")).toHaveText(["시가", "고가", "저가", "종가"]);
    await page.keyboard.press("Escape");
  });

  await test.step("주봉 신고가 줄에서 신고거래대금을, 더한 줄에서 신고거래량을 고르면 둘 다 일봉·최근 100일·200일로 시작한다", async () => {
    const dialog = editor(page, "조건식 편집");
    await chooseKind(dialog, 1, { label: "신고거래대금" });
    await expect(box(dialog, 1, "최근 기간")).toHaveText("4");
    await fillNumber(box(dialog, 1, "최근 기간"), "100");
    await expectTradeHighLine(dialog, 1, TRADED_VALUE, "D", "200", "100");
    await addCondition(dialog);
    await chooseKind(dialog, 2, { label: "신고거래량" });
    await expect(box(dialog, 2, "최근 기간")).toHaveText("1");
    await fillNumber(box(dialog, 2, "최근 기간"), "100");
    await expectTradeHighLine(dialog, 2, VOLUME, "D", "200", "100");
    await expectSentences(dialog, [TRADED_START_TEXT, VOLUME_START_TEXT]);
  });

  await test.step("봉 주기와 계산 기간·최근 기간을 바꾸면 그 단위로 읽히고, 최근 기간이 0이면 저장이 막힌다", async () => {
    const dialog = editor(page, "조건식 편집");
    await renameScreen(dialog, PICKED);
    await selectOption(choice(dialog, 2, "봉 주기"), "W");
    await fillNumber(box(dialog, 2, "신고거래량 기간"), "52");
    await fillNumber(box(dialog, 2, "최근 기간"), "0");
    await expectSentences(dialog, [TRADED_START_TEXT, "최근 기간: 1 이상의 정수를 넣으세요"]);
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(box(dialog, 2, "최근 기간")).toBeFocused();
    await expect(box(dialog, 2, "최근 기간")).toHaveAttribute("aria-invalid", "true");
    await fillNumber(box(dialog, 2, "최근 기간"), "8");
    await expectTradeHighLine(dialog, 2, VOLUME, "W", "52", "8");
    await expectSentences(dialog, [TRADED_START_TEXT, WEEKLY_VOLUME_TEXT]);
    await save(page, dialog);
    await expectSentences(panel(page), [TRADED_START_TEXT, `그리고${WEEKLY_VOLUME_TEXT}`]);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens).toEqual([
      { ...WEEKLY_HIGH, name: PICKED, conditions: [newHigh("D", "traded_value", 200, 100), newHigh("W", "volume", 52, 8)] },
      { ...OLD_VOLUME, name: RENAMED_OLD },
    ]);
  });

  await test.step("실행하면 첫 줄 신고거래대금이 일봉 최근 100일 이내 마지막으로 맞은 날이 맞은 날짜로 나온다", async () => {
    await run(page);
    await expect(results(page)).toContainText("9종목 · 11-06(금) 기준");
    await expect(excludedLine(page)).toHaveText(EXCLUDED);
    await expectRows(page, [
      ["120040", "가상거래한산", "당일"],
      ["120020", "가상코스닥교차", "11-03"],
      ["120030", "가상횡보", "11-03"],
      ["120050", "가상전고점", "11-03"],
      ["120060", "가상시총미달", "11-03"],
      ["120010", "가상교차급증", "11-02"],
      ["110050", "가상관리", "10-12"],
      ["110060", "가상200", "10-12"],
      ["110070", "가상리츠", "09-14"],
    ]);
  });

  await test.step("새로 고침 뒤 다시 열어도 고른 항목과 바꾼 봉 주기·기간이 그대로다", async () => {
    await page.reload();
    await openScreener(page);
    const dialog = await editScreen(page, PICKED);
    await expectTradeHighLine(dialog, 1, TRADED_VALUE, "D", "200", "100");
    await expectTradeHighLine(dialog, 2, VOLUME, "W", "52", "8");
    await expectSentences(dialog, [TRADED_START_TEXT, WEEKLY_VOLUME_TEXT]);
    expect(screenSaves).toHaveLength(2);
  });

  await test.step("두 줄을 월봉으로 바꾸고 N·M을 고쳐 저장하면, 새로 고침 뒤 다시 열어도 월봉과 고친 기간이 그대로다", async () => {
    let dialog = editor(page, "조건식 편집");
    await selectOption(choice(dialog, 1, "봉 주기"), "M");
    await fillNumber(box(dialog, 1, "신고거래대금 기간"), "24");
    await fillNumber(box(dialog, 1, "최근 기간"), "6");
    await selectOption(choice(dialog, 2, "봉 주기"), "M");
    await fillNumber(box(dialog, 2, "신고거래량 기간"), "12");
    await fillNumber(box(dialog, 2, "최근 기간"), "3");
    await expectSentences(dialog, [MONTHLY_TRADED_TEXT, MONTHLY_VOLUME_TEXT]);
    await save(page, dialog);
    expect(screenSaves).toHaveLength(3);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens[0]).toEqual({ ...WEEKLY_HIGH, name: PICKED, conditions: [newHigh("M", "traded_value", 24, 6), newHigh("M", "volume", 12, 3)] });

    await page.reload();
    await openScreener(page);
    dialog = await editScreen(page, PICKED);
    await expectTradeHighLine(dialog, 1, TRADED_VALUE, "M", "24", "6");
    await expectTradeHighLine(dialog, 2, VOLUME, "M", "12", "3");
    await expectSentences(dialog, [MONTHLY_TRADED_TEXT, MONTHLY_VOLUME_TEXT]);
    await savedEditor(dialog);
    await expectSentences(panel(page), [MONTHLY_TRADED_TEXT, `그리고${MONTHLY_VOLUME_TEXT}`]);
    expect(screenSaves).toHaveLength(3);
  });
});
