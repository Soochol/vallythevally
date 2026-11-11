import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./harness";
import { editor, excludedLine, expectRows, openScreener, panel, results, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", krxConditionStocks: true, clockStart: "20261109100000" });

const newHigh = (period: string, field: string, n: number, m: number) => ({ kind: "new_high", period, m, field, n });
const WEEKLY_HIGH = { id: "plain", name: "주봉 신고가", markets: [], exclude: [], conditions: [newHigh("W", "high", 52, 4)] };
const OLD_VOLUME = { id: "old-volume", name: "신고가 값으로 고른 신고거래량", markets: [], exclude: [], conditions: [newHigh("W", "volume", 52, 4)] };
const RENAMED_OLD = "옛 신고거래량 이름만 바꿈";
const PICKED = "신고거래대금과 주봉 신고거래량";

const OLD_VOLUME_TEXT = "최근 4주 안에 거래량이 52주 신고거래량인 봉이 있다";
const TRADED_START_TEXT = "최근 100일 안에 거래대금이 200일 신고거래대금인 봉이 있다";
const VOLUME_START_TEXT = "최근 100일 안에 거래량이 200일 신고거래량인 봉이 있다";
const WEEKLY_VOLUME_TEXT = "최근 8주 안에 거래량이 52주 신고거래량인 봉이 있다";
const MONTHLY_TRADED_TEXT = "최근 6개월 안에 거래대금이 24개월 신고거래대금인 봉이 있다";
const MONTHLY_VOLUME_TEXT = "최근 3개월 안에 거래량이 12개월 신고거래량인 봉이 있다";
const EXCLUDED = "대상 16종목 · 빠짐: 상장 기간 부족 2 · 이력 덜 참 0";

const choice = (dialog: Locator, line: number, name: string) => dialog.getByRole("combobox", { name: `조건 ${line} ${name}` });
const box = (dialog: Locator, line: number, name: string) => dialog.getByRole("textbox", { name: `조건 ${line} ${name}` });
const lineTexts = (dialog: Locator) => dialog.getByRole("list", { name: "조건" }).getByRole("listitem").locator(":scope > p");
const panelLines = (page: Page) => panel(page).getByRole("list", { name: "조건" }).getByRole("listitem");
const optionsIn = (select: Locator, group: string) => select.locator(`optgroup[label="${group}"] > option`);

async function editScreen(page: Page, name: string) {
  await panel(page).getByRole("button", { name: /^조건식: / }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(panel(page).getByRole("button", { name: `조건식: ${name}` })).toBeVisible();
  await panel(page).getByRole("button", { name: "편집" }).click();
  return editor(page, "조건식 편집");
}

async function expectTradeHighLine(dialog: Locator, line: number, kind: { value: string; label: string }, period: string, n: string, m: string) {
  await expect(choice(dialog, line, "종류")).toHaveValue(kind.value);
  await expect(choice(dialog, line, "종류").locator("option:checked")).toHaveText(kind.label);
  await expect(choice(dialog, line, "봉 주기")).toHaveValue(period);
  await expect(choice(dialog, line, "값")).toHaveCount(0);
  await expect(box(dialog, line, `${kind.label} 기간`)).toHaveValue(n);
  await expect(box(dialog, line, "최근 봉 수")).toHaveValue(m);
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await expect(dialog).toBeHidden();
}

async function run(page: Page) {
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
}

const VOLUME = { value: "volume_high", label: "신고거래량" };
const TRADED_VALUE = { value: "traded_value_high", label: "신고거래대금" };

test("거래 분류의 신고거래량·신고거래대금은 새로 고르면 일봉·최근 100일·200일로 시작하고, 바꾼 봉 주기와 기간은 저장하고 다시 열어도 남으며, 신고가 값으로 고른 옛 조건식도 그 항목으로 그대로 열리고 실행된다", async ({ app, page }) => {
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
    await expect(lineTexts(dialog)).toHaveText([OLD_VOLUME_TEXT]);
    await dialog.getByRole("button", { name: "취소" }).click();
    await expect(dialog).toBeHidden();
    expect(screenSaves).toEqual([]);
    await expect(panelLines(page)).toHaveText([OLD_VOLUME_TEXT]);
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
    await dialog.getByLabel("이름").fill(RENAMED_OLD);
    await save(page, dialog);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens).toEqual([WEEKLY_HIGH, { ...OLD_VOLUME, name: RENAMED_OLD }]);
  });

  await test.step("거래 분류에 신고거래량·신고거래대금·거래 급증이 있고, 신고가의 값은 가격만이다", async () => {
    const dialog = await editScreen(page, WEEKLY_HIGH.name);
    await expect(optionsIn(choice(dialog, 1, "종류"), "거래")).toHaveText(["신고거래량", "신고거래대금", "거래 급증"]);
    await expect(choice(dialog, 1, "값").locator("option")).toHaveText(["시가", "고가", "저가", "종가"]);
  });

  await test.step("주봉 신고가 줄에서 신고거래대금을, 더한 줄에서 신고거래량을 고르면 둘 다 일봉·최근 100일·200일로 시작한다", async () => {
    const dialog = editor(page, "조건식 편집");
    await choice(dialog, 1, "종류").selectOption({ label: "신고거래대금" });
    await expectTradeHighLine(dialog, 1, TRADED_VALUE, "D", "200", "100");
    await dialog.getByRole("button", { name: "조건 더하기" }).click();
    await choice(dialog, 2, "종류").selectOption({ label: "신고거래량" });
    await expectTradeHighLine(dialog, 2, VOLUME, "D", "200", "100");
    await expect(lineTexts(dialog)).toHaveText([TRADED_START_TEXT, VOLUME_START_TEXT]);
  });

  await test.step("봉 주기와 N·M을 바꾸면 그 단위로 읽히고, 최근 봉 수가 비교 기간보다 길면 그 칸에서 저장이 막힌다", async () => {
    const dialog = editor(page, "조건식 편집");
    await dialog.getByLabel("이름").fill(PICKED);
    await choice(dialog, 2, "봉 주기").selectOption("W");
    await box(dialog, 2, "신고거래량 기간").fill("52");
    await box(dialog, 2, "최근 봉 수").fill("53");
    await expect(lineTexts(dialog)).toHaveText([TRADED_START_TEXT, "최근 봉 수: 신고거래량 기간 52주보다 길 수 없습니다"]);
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(box(dialog, 2, "최근 봉 수")).toBeFocused();
    await expect(box(dialog, 2, "최근 봉 수")).toHaveAttribute("aria-invalid", "true");
    await box(dialog, 2, "최근 봉 수").fill("8");
    await expectTradeHighLine(dialog, 2, VOLUME, "W", "52", "8");
    await expect(lineTexts(dialog)).toHaveText([TRADED_START_TEXT, WEEKLY_VOLUME_TEXT]);
    await save(page, dialog);
    await expect(panelLines(page)).toHaveText([TRADED_START_TEXT, `그리고${WEEKLY_VOLUME_TEXT}`]);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens).toEqual([
      { ...WEEKLY_HIGH, name: PICKED, conditions: [newHigh("D", "traded_value", 200, 100), newHigh("W", "volume", 52, 8)] },
      { ...OLD_VOLUME, name: RENAMED_OLD },
    ]);
  });

  await test.step("실행하면 첫 줄 신고거래대금이 최근 100일 안에 마지막으로 맞은 날이 맞은 날짜로 나온다", async () => {
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
    await expect(lineTexts(dialog)).toHaveText([TRADED_START_TEXT, WEEKLY_VOLUME_TEXT]);
    expect(screenSaves).toHaveLength(2);
  });

  await test.step("두 줄을 월봉으로 바꾸고 N·M을 고쳐 저장하면, 새로 고침 뒤 다시 열어도 월봉과 고친 기간이 그대로다", async () => {
    let dialog = editor(page, "조건식 편집");
    await choice(dialog, 1, "봉 주기").selectOption("M");
    await box(dialog, 1, "신고거래대금 기간").fill("24");
    await box(dialog, 1, "최근 봉 수").fill("6");
    await choice(dialog, 2, "봉 주기").selectOption("M");
    await box(dialog, 2, "신고거래량 기간").fill("12");
    await box(dialog, 2, "최근 봉 수").fill("3");
    await expect(lineTexts(dialog)).toHaveText([MONTHLY_TRADED_TEXT, MONTHLY_VOLUME_TEXT]);
    await save(page, dialog);
    expect(screenSaves).toHaveLength(3);
    const stored = await (await fetch(screensUrl)).json();
    expect(stored.screens[0]).toEqual({ ...WEEKLY_HIGH, name: PICKED, conditions: [newHigh("M", "traded_value", 24, 6), newHigh("M", "volume", 12, 3)] });

    await page.reload();
    await openScreener(page);
    dialog = await editScreen(page, PICKED);
    await expectTradeHighLine(dialog, 1, TRADED_VALUE, "M", "24", "6");
    await expectTradeHighLine(dialog, 2, VOLUME, "M", "12", "3");
    await expect(lineTexts(dialog)).toHaveText([MONTHLY_TRADED_TEXT, MONTHLY_VOLUME_TEXT]);
    await dialog.getByRole("button", { name: "취소" }).click();
    await expect(dialog).toBeHidden();
    await expect(panelLines(page)).toHaveText([MONTHLY_TRADED_TEXT, `그리고${MONTHLY_VOLUME_TEXT}`]);
    expect(screenSaves).toHaveLength(3);
  });
});
