import { selectOption } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./harness";
import { editor, excludedLine, expectCellOn, expectRows, openScreener, panel, pickPeriod, pickVenue, results, rows, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", krxConditionStocks: true, clockStart: "20261106203000" });

const SCREEN_NAME = "교차 급증 주봉 신고가";
const CROSS = "일봉 0~4봉 전 안에 5일선이 20일선을 위로 교차한 봉이 있다";
const WEEKLY_HIGH = "주봉 0봉 전 종가가 52주 신고가다";
const SURGE = "일봉 0~9봉 전 안에 거래량이 직전 20일 평균의 3배 이상인 봉이 있다";
const RISE = "일봉 0~9봉 전 안에 종가가 1일 전보다 +5% 이상인 봉이 있다";
const MARKET_CAP = "시가총액이 3,000억 원 이상이다";

const KOSPI_HIT = ["120010", "가상교차급증", "11-05"] as const;
const KOSDAQ_HIT = ["120020", "가상코스닥교차", "11-04"] as const;
const QUIET_RISE = ["120040", "가상거래한산", "11-03"] as const;

const choice = (dialog: Locator, line: number, name: string) => dialog.getByRole("combobox", { name: `조건 ${line} ${name}` });
const box = (dialog: Locator, line: number, name: string) => dialog.getByRole("textbox", { name: `조건 ${line} ${name}` });
const lineTexts = (dialog: Locator) => dialog.getByRole("list", { name: "조건" }).getByRole("listitem").locator(":scope > p");
const marketChip = (dialog: Locator, name: string) => dialog.getByRole("group", { name: "시장" }).getByRole("button", { name });

async function editScreen(page: Page) {
  await panel(page).getByRole("button", { name: "편집" }).click();
  return editor(page, "조건식 편집");
}

async function save(page: Page, dialog: Locator) {
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await expect(dialog).toBeHidden();
}

async function runAndExpect(page: Page, excluded: string, expected: readonly (readonly [code: string, name: string, matchedDate: string])[]) {
  await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
  await runButton(page).click();
  await expect(results(page)).toContainText(`${expected.length}종목 · 11-06(금) 기준`);
  await expect(excludedLine(page)).toHaveText(excluded);
  await expectRows(page, expected);
}

test("봉·지표·시가총액 줄을 일봉과 주봉으로 섞어 만들고 ▲▼로 옮겨 실행하면 첫 줄이 맞은 날짜를 정하고, 행을 열어도 칸의 거래소와 봉 주기는 그대로이며, 종류를 바꾸면 잘못된 값은 막히고 시장 칩은 결과를 가른다", async ({ app, page }) => {
  test.setTimeout(180_000);
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
    await dialog.getByLabel("이름").fill(SCREEN_NAME);
    await dialog.getByRole("button", { name: "조건 더하기" }).click();
    await selectOption(choice(dialog, 1, "봉 주기"), "W");
    await selectOption(choice(dialog, 1, "값"), "close");
    await box(dialog, 1, "신고가 기간").fill("52");

    await dialog.getByRole("button", { name: "조건 더하기" }).click();
    await expect(choice(dialog, 2, "봉 주기")).toHaveAttribute("data-value", "W");
    await selectOption(choice(dialog, 2, "종류"), "surge");
    await selectOption(choice(dialog, 2, "봉 주기"), "D");
    await box(dialog, 2, "봉 범위 끝").fill("9");

    await dialog.getByRole("button", { name: "조건 더하기" }).click();
    await expect(choice(dialog, 3, "봉 주기")).toHaveAttribute("data-value", "D");
    await selectOption(choice(dialog, 3, "종류"), "ma_cross");
    await box(dialog, 3, "봉 범위 끝").fill("4");

    await dialog.getByRole("button", { name: "조건 더하기" }).click();
    await selectOption(choice(dialog, 4, "종류"), "market_cap");
    await expect(choice(dialog, 4, "봉 주기")).toHaveCount(0);
    await expect(lineTexts(dialog)).toHaveText([WEEKLY_HIGH, SURGE, CROSS, MARKET_CAP]);
  });

  await test.step("▲▼로 이평 교차 줄을 맨 위로 올리고 저장한다", async () => {
    const dialog = editor(page, "새 조건식");
    await dialog.getByRole("button", { name: "조건 3 위로 옮기기" }).click();
    await expect(lineTexts(dialog)).toHaveText([WEEKLY_HIGH, CROSS, SURGE, MARKET_CAP]);
    await dialog.getByRole("button", { name: "조건 1 아래로 옮기기" }).click();
    await expect(lineTexts(dialog)).toHaveText([CROSS, WEEKLY_HIGH, SURGE, MARKET_CAP]);
    await save(page, dialog);

    await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
    await expect(panel(page).getByRole("list", { name: "조건" }).getByRole("listitem")).toHaveText([CROSS, `그리고${WEEKLY_HIGH}`, `그리고${SURGE}`, `그리고${MARKET_CAP}`]);
    const stored = await (await fetch(`${app.url}/api/screens`)).json();
    expect(stored.screens).toEqual([
      {
        id: expect.any(String),
        name: SCREEN_NAME,
        markets: [],
        exclude: [],
        conditions: [
          { kind: "ma_cross", period: "D", barRange: { start: 0, end: 4 }, method: "sma", fast: 5, slow: 20, direction: "up" },
          { kind: "new_high", period: "W", barRange: { start: 0, end: 0 }, field: "close", n: 52 },
          { kind: "surge", period: "D", barRange: { start: 0, end: 9 }, field: "volume", n: 20, times: 3 },
          { kind: "market_cap", min: 300_000_000_000, max: null },
        ],
      },
    ]);
  });

  await test.step("실행하면 모든 줄을 넘은 두 종목이 교차한 날짜로 나오고, 주봉 52칸이 모자란 두 종목은 상장 기간 부족으로 빠진다", async () => {
    await runAndExpect(page, "대상 16종목 · 빠짐: 상장 기간 부족 2 · 이력 덜 참 0", [KOSPI_HIT, KOSDAQ_HIT]);
  });

  await test.step("행을 열면 칸의 종목만 바뀌고, 고른 거래소와 봉 주기는 그대로다", async () => {
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상교차급증 통합 일");
    await pickVenue(page, "KRX");
    await pickPeriod(page, "월");
    await expectCellOn(page, rows(page).nth(0), "가상교차급증 KRX 월");
    await rows(page).nth(1).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(1), "가상코스닥교차 KRX 월");
    expect(barRequests).toContain("120020:krx:M");
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상교차급증 KRX 월");
  });

  await test.step("거래 급증 줄을 등락률로 바꾸면 봉 주기와 M은 남고, 짧은 이평이 긴 이평보다 길거나 최대가 최소보다 작으면 그 칸에서 이유와 함께 저장이 막힌다", async () => {
    const dialog = await editScreen(page);
    await selectOption(choice(dialog, 3, "종류"), "change");
    await expect(choice(dialog, 3, "봉 주기")).toHaveAttribute("data-value", "D");
    await expect(box(dialog, 3, "봉 범위 끝")).toHaveValue("9");
    await expect(box(dialog, 3, "비교 봉 수")).toHaveValue("1");
    await expect(box(dialog, 3, "최소 등락률")).toHaveValue("5");
    await expect(box(dialog, 3, "최대 등락률")).toHaveValue("");
    await expect(lineTexts(dialog)).toHaveText([CROSS, WEEKLY_HIGH, RISE, MARKET_CAP]);

    await box(dialog, 1, "짧은 이평").fill("20");
    await box(dialog, 3, "최대 등락률").fill("3");
    await expect(lineTexts(dialog)).toHaveText(["짧은 이평: 긴 이평 20일보다 짧아야 합니다", WEEKLY_HIGH, "최대 등락률: 최소보다 작을 수 없습니다", MARKET_CAP]);
    await expect(box(dialog, 1, "짧은 이평")).toHaveAttribute("aria-invalid", "true");
    await expect(box(dialog, 3, "최대 등락률")).toHaveAttribute("aria-invalid", "true");
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(box(dialog, 1, "짧은 이평")).toBeFocused();
    await expect(dialog).toBeVisible();

    await box(dialog, 1, "짧은 이평").fill("5");
    await box(dialog, 3, "최대 등락률").fill("");
    await expect(lineTexts(dialog)).toHaveText([CROSS, WEEKLY_HIGH, RISE, MARKET_CAP]);
    await save(page, dialog);
    expect(screenSaves).toHaveLength(2);
  });

  await test.step("바꾼 등락률 줄로 실행하면 거래가 몰리지 않았던 종목도 맞는다", async () => {
    await runAndExpect(page, "대상 16종목 · 빠짐: 상장 기간 부족 2 · 이력 덜 참 0", [KOSPI_HIT, KOSDAQ_HIT, QUIET_RISE]);
  });

  await test.step("시장 칩으로 코스피만 고르면 코스피 종목만, 코스닥만 고르면 코스닥 종목만 대상이 된다", async () => {
    let dialog = await editScreen(page);
    await marketChip(dialog, "코스피").click();
    await save(page, dialog);
    await runAndExpect(page, "대상 9종목 · 빠짐: 상장 기간 부족 1 · 이력 덜 참 0", [KOSPI_HIT, QUIET_RISE]);

    dialog = await editScreen(page);
    await marketChip(dialog, "코스피").click();
    await marketChip(dialog, "코스닥").click();
    await save(page, dialog);
    await runAndExpect(page, "대상 7종목 · 빠짐: 상장 기간 부족 1 · 이력 덜 참 0", [KOSDAQ_HIT]);
    expect(screenSaves).toHaveLength(4);
  });
});

test("봉 범위 양 끝을 검증하고 저장 전 실행 API와 저장 충돌에서도 새 범위를 유지하며 변환 안내를 띄우지 않는다", async ({ app, page }, testInfo) => {
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await panel(page).getByRole("button", { name: "새 조건식" }).click();
  const dialog = editor(page, "새 조건식");
  await dialog.getByLabel("이름").fill("과거 봉 범위");
  await dialog.getByRole("button", { name: "조건 더하기" }).click();
  await box(dialog, 1, "신고가 기간").fill("2");
  const start = box(dialog, 1, "봉 범위 시작");
  const end = box(dialog, 1, "봉 범위 끝");
  await expect(start).toHaveValue("0");
  await expect(end).toHaveValue("0");
  for (const bad of ["", "-1", "0.5"]) {
    await start.fill(bad);
    await expect(start).toHaveAttribute("aria-invalid", "true");
  }
  await start.fill("3");
  await end.fill("1");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(end).toBeFocused();
  await expect(end).toHaveAttribute("aria-invalid", "true");
  await start.fill("1");
  await end.fill("3");
  await expect(lineTexts(dialog)).toHaveText(["일봉 1~3봉 전 안에 고가가 2일 신고가인 봉이 있다"]);
  const unsaved = { id: "unsaved-range", name: "과거 봉 범위", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", barRange: { start: 1, end: 3 }, field: "high", n: 2 }] };
  const run = await page.request.post(`${app.url}/api/screener/run`, { data: unsaved });
  expect(run.status()).toBe(200);
  expect((await run.json()).rows.length).toBeGreaterThan(0);
  const before = await (await page.request.get(`${app.url}/api/screens`)).json();
  expect(before.screens).toEqual([]);
  const competing = await page.request.put(`${app.url}/api/screens`, { data: { ...before, revision: before.revision + 1, screens: [{ ...unsaved, id: "other", name: "다른 탭 조건" }] } });
  expect(competing.status()).toBe(200);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByRole("alert")).toContainText("다른");
  await expect(start).toHaveValue("1");
  await expect(end).toHaveValue("3");
  await save(page, dialog);
  const saved = await (await page.request.get(`${app.url}/api/screens`)).json();
  expect(saved.screens).toHaveLength(2);
  expect(saved.screens[1].conditions).toEqual(unsaved.conditions);
  await expect(page.getByText(/자동 (이전|변환)|변환 안내|변경 안내/)).toHaveCount(0);
  const edited = await editScreen(page);
  await expect(box(edited, 1, "봉 범위 시작")).toHaveValue("1");
  await expect(box(edited, 1, "봉 범위 끝")).toHaveValue("3");
  await page.screenshot({ path: testInfo.outputPath("bar-range-editor.png"), fullPage: true });
});
