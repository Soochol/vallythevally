import type { Locator, Page } from "@playwright/test";
import { type App, cell, chartOf, expect, SEARCH_BUTTON_TITLE, test } from "./harness";
import { editor, excludedLine, expectCellOn, expectRows, openScreener, panel, pickPeriod, pickVenue, rail, results, rows, runButton, savedTo, storeLine, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261109100000" });

const NEXT_MORNING = { market: "20261109", clockStart: "20261110100000" };
const SCREEN_NAME = "고가 60일 신고가";
const EDITED_NAME = "고가 60일 신고가 정지 제외";

const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });

async function expectWatchlistOfResults(page: Page) {
  await expect(watchPanel(page).getByRole("button", { name: /^관심종목 목록: / })).toHaveAccessibleName(`관심종목 목록: ${SCREEN_NAME}`);
  await expect.poll(() => watchPanel(page).locator("li[data-code]").evaluateAll((li) => li.map((e) => e.getAttribute("data-code")))).toEqual(["110030", "110035", "110040", "110050"]);
}

const SEEDED_SCREEN = { id: "seeded", name: SCREEN_NAME, markets: [], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", m: 20, field: "high", n: 60 }] };
const LATE_ANSWER_SETTLE_MS = 300;
const phoneTabs = (page: Page) => page.getByRole("navigation", { name: "휴대폰 탭" });
const openPhoneScreener = (page: Page) => phoneTabs(page).getByRole("button", { name: "스크리너" }).click();

async function runSeededScreen(app: App, page: Page, openPanel: (page: Page) => Promise<void>) {
  const seeded = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [SEEDED_SCREEN], revision: 1 }) });
  expect(seeded.status).toBe(200);
  await page.goto("/");
  await openPanel(page);
  await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(rows(page)).toHaveCount(4);
}

async function holdSymbolInfo(page: Page, code: string) {
  const path = `/api/symbols/${code}`;
  let letGo = () => {};
  const released = new Promise<void>((resolve) => (letGo = resolve));
  await page.route(`**${path}`, async (route) => {
    await released;
    await route.continue();
  });
  return {
    requested: page.waitForRequest((r) => new URL(r.url()).pathname === path),
    release: async () => {
      const finished = page.waitForEvent("requestfinished", (r) => new URL(r.url()).pathname === path);
      letGo();
      await finished;
      await page.waitForTimeout(LATE_ANSWER_SETTLE_MS);
    },
  };
}

test("빈 저장소를 채우고 만든 조건식으로 찾은 종목을 칸의 거래소와 봉 주기 그대로 훑고, 다음 날 자료 부족을 채운 뒤 고치고 지운다", async ({ app, page }) => {
  test.setTimeout(180_000);
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
    await expect(storeLine(page)).toContainText("당일 봉은 20:00 뒤에 받습니다");
  });

  await test.step("조건식 만들기", async () => {
    await panel(page).getByRole("button", { name: "새 조건식" }).click();
    const dialog = editor(page, "새 조건식");
    await dialog.getByLabel("이름").fill(SCREEN_NAME);
    await dialog.getByRole("textbox", { name: "조건 1 신고가 기간" }).fill("60");
    await dialog.getByRole("textbox", { name: "조건 1 최근 봉 수" }).fill("20");
    await dialog.getByRole("group", { name: "종류 제외" }).getByRole("button", { name: "ETF" }).click();
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await expect(dialog).toBeHidden();
    await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
    await expect(panel(page).getByRole("list", { name: "조건" })).toHaveText("최근 20일 안에 고가가 60일 신고가인 봉이 있다");
    await expect(panel(page).getByText("ETF", { exact: true })).toBeVisible();
    await expect(panel(page).getByText("11-06(금) 장 마감 자료로 찾습니다")).toBeVisible();
  });

  await test.step("실행", async () => {
    await runButton(page).click();
    await expect(results(page)).toContainText("4종목 · 11-06(금) 기준");
    await expect(results(page)).toContainText("대상 9종목 · 빠짐: 상장 기간 부족 1 · 이력 덜 참 0");
    await expect(results(page).getByRole("button", { name: /^맞은 날짜 순으로 정렬/ })).toHaveAttribute("aria-pressed", "true");
    await expectRows(page, [
      ["110030", "가상분할", "당일"],
      ["110035", "가상전자우", "당일"],
      ["110040", "가상정지", "10-23"],
      ["110050", "가상관리", "10-19"],
    ]);
    await expect(rail(page).getByRole("button", { name: /^스크리너/ })).toContainText("결과 4종목");
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
    await rail(page).getByRole("button", { name: "관심종목" }).click();
    await expectWatchlistOfResults(page);
  });

  await test.step("다음 날 아침에는 자료가 모자라 실행이 막히고, 업데이트하면 다시 실행된다", async () => {
    await app.fake.setKrxMarket(NEXT_MORNING.market);
    await app.restart({ clockStart: NEXT_MORNING.clockStart });
    await page.reload();
    await expectWatchlistOfResults(page);
    await openScreener(page);
    await expect(updateBand(page)).toContainText("자료가 모자랍니다");
    await expect(updateBand(page)).toContainText("11-06(금)까지 있습니다. 실행하려면 11-09(월) 자료가 있어야 합니다. 당일 봉은 20:00 뒤에 받습니다.");
    await expect(runButton(page)).toBeDisabled();
    await expect(panel(page).getByText("자료가 모자라 실행할 수 없습니다")).toBeVisible();
    await expect(panel(page).getByText("새 자료가 필요합니다")).toBeVisible();

    await updateBand(page).getByRole("button", { name: "업데이트" }).click();
    await waitForUpdateToFinish(page, "11-09(월)");
    await runButton(page).click();
    await expect(results(page)).toContainText("4종목 · 11-09(월) 기준");
  });

  await test.step("조건식을 고치면 고친 조건으로 실행된다", async () => {
    await panel(page).getByRole("button", { name: "편집" }).click();
    const dialog = editor(page, "조건식 편집");
    await dialog.getByLabel("이름").fill(EDITED_NAME);
    await dialog.getByRole("group", { name: "상태 제외" }).getByRole("button", { name: "거래정지" }).click();
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await expect(dialog).toBeHidden();
    await expect(panel(page).getByRole("button", { name: `조건식: ${EDITED_NAME}` })).toBeVisible();
    await expect(panel(page).getByText("실행하면 결과가 여기에 나옵니다")).toBeVisible();
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
    await expect(panel(page).getByRole("button", { name: `조건식: ${EDITED_NAME}` })).toBeVisible();
    await panel(page).getByRole("button", { name: "편집" }).click();
    const dialog = editor(page, "조건식 편집");
    const confirmed = page.waitForEvent("dialog").then(async (d) => {
      expect(d.message()).toBe(`"${EDITED_NAME}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`);
      await d.accept();
    });
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "삭제" }).click();
    await confirmed;
    await saved;
    await expect(dialog).toBeHidden();
    await expect(panel(page).getByText("저장한 조건식이 없습니다")).toBeVisible();
    await page.reload();
    await openScreener(page);
    await expect(panel(page).getByText("저장한 조건식이 없습니다")).toBeVisible();
  });
});

test("시가총액 줄이나 줄마다 다른 봉 주기가 든 조건식도 편집에서 그대로 열리고, 이름만 바꿔 저장해도 줄과 시장이 그대로 남으며, 거래대금 신고가 줄은 신고거래대금 항목으로 보인다", async ({ app, page }) => {
  const newHigh = (period: string, field: string, n: number, m: number) => ({ kind: "new_high", period, m, field, n });
  const capped = { id: "capped", name: "시가총액 섞임", markets: [], exclude: [], conditions: [newHigh("D", "high", 60, 1), { kind: "market_cap", min: 300_000_000_000, max: null }] };
  const mixed = { id: "mixed", name: "주봉 섞임", markets: ["kosdaq"], exclude: [], conditions: [newHigh("D", "high", 60, 1), newHigh("W", "close", 52, 1)] };
  const traded = { id: "traded", name: "신고거래대금", markets: [], exclude: [], conditions: [newHigh("D", "traded_value", 60, 1)] };
  const screensUrl = `${app.url}/api/screens`;
  const seeded = await fetch(screensUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [capped, mixed, traded], revision: 1 }) });
  expect(seeded.status).toBe(200);
  await page.goto("/");
  await openScreener(page);
  const edit = async (name: string) => {
    await panel(page).getByRole("button", { name: /^조건식: / }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
    await expect(panel(page).getByRole("button", { name: `조건식: ${name}` })).toBeVisible();
    await panel(page).getByRole("button", { name: "편집" }).click();
    const dialog = editor(page, "조건식 편집");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    return dialog;
  };
  const renameAndSave = async (dialog: Locator, name: string) => {
    await dialog.getByLabel("이름").fill(name);
    const saved = savedTo(page, "/api/screens");
    await dialog.getByRole("button", { name: "저장" }).click();
    await saved;
    await expect(dialog).toBeHidden();
  };

  await test.step("시가총액 줄은 봉 주기 없이 억 원으로 보이고, 이름만 바꿔 저장된다", async () => {
    const dialog = await edit(capped.name);
    await expect(dialog.getByRole("combobox", { name: "조건 2 종류" })).toHaveValue("market_cap");
    await expect(dialog.getByRole("combobox", { name: "조건 2 봉 주기" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "조건 2 최소" })).toHaveValue("3000");
    await expect(dialog.getByText("시가총액이 3,000억 원 이상이다")).toBeVisible();
    await renameAndSave(dialog, "시가총액 섞임 바꿈");
  });

  await test.step("줄마다 다른 봉 주기와 고른 시장이 보이고, 이름만 바꿔 저장된다", async () => {
    const dialog = await edit(mixed.name);
    await expect(dialog.getByRole("combobox", { name: "조건 1 봉 주기" })).toHaveValue("D");
    await expect(dialog.getByRole("combobox", { name: "조건 2 봉 주기" })).toHaveValue("W");
    await expect(dialog.getByText("이번 주 종가가 52주 신고가다")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스피" })).toHaveAttribute("aria-pressed", "false");
    await renameAndSave(dialog, "주봉 섞임 바꿈");
  });

  await test.step("거래대금 신고가 줄은 종류 칸에 신고거래대금이 골라져 있고 기간이 그대로이며, 이름을 바꿔 저장해도 거래대금이다", async () => {
    const dialog = await edit(traded.name);
    const kind = dialog.getByRole("combobox", { name: "조건 1 종류" });
    await expect(kind).toHaveValue("traded_value_high");
    await expect(kind.locator("option:checked")).toHaveText("신고거래대금");
    await expect(dialog.getByRole("textbox", { name: "조건 1 신고거래대금 기간" })).toHaveValue("60");
    await expect(dialog.getByRole("textbox", { name: "조건 1 최근 봉 수" })).toHaveValue("1");
    await expect(dialog.getByText("당일 거래대금이 60일 신고거래대금이다")).toBeVisible();
    await renameAndSave(dialog, "신고거래대금 바꿈");
  });

  const stored = await (await fetch(screensUrl)).json();
  expect(stored.screens).toEqual([
    { ...capped, name: "시가총액 섞임 바꿈" },
    { ...mixed, name: "주봉 섞임 바꿈" },
    { ...traded, name: "신고거래대금 바꿈" },
  ]);
});

test("패널 머리는 줄마다 그 줄의 봉 주기로 조건을 풀고, 시장 칩을 제외 칩과 함께 보이며, 조건식 메뉴에는 이름만 보인다", async ({ app, page }) => {
  const newHigh = (period: string, field: string, n: number, m: number) => ({ kind: "new_high", period, m, field, n });
  const mixed = { id: "mixed", name: "주봉 신고가와 일봉 신고거래량", markets: ["kosdaq"], exclude: ["managed", "etf"], conditions: [newHigh("W", "close", 52, 1), newHigh("D", "volume", 60, 5)] };
  const plain = { id: "plain", name: "전 종목 신고가", markets: [], exclude: [], conditions: [newHigh("M", "high", 12, 1)] };
  const seeded = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [mixed, plain], revision: 1 }) });
  expect(seeded.status).toBe(200);
  await page.goto("/");
  await openScreener(page);

  const conditions = panel(page).getByRole("list", { name: "조건" });
  const scope = conditions.locator("xpath=../p");
  await expect(panel(page).getByRole("button", { name: `조건식: ${mixed.name}` })).toBeVisible();
  await expect(conditions.getByRole("listitem")).toHaveText(["이번 주 종가가 52주 신고가다", "그리고최근 5일 안에 거래량이 60일 신고거래량인 봉이 있다"]);
  await expect(scope).toHaveText("대상코스닥·제외ETF관리종목");

  await panel(page).getByRole("button", { name: /^조건식: / }).click();
  await expect(page.getByRole("menu", { name: "조건식 고르기" }).getByRole("menuitemradio")).toHaveText([mixed.name, plain.name]);
  await page.getByRole("menuitemradio", { name: plain.name, exact: true }).click();
  await expect(conditions).toHaveText("이번 달 고가가 12개월 신고가다");
  await expect(scope).toHaveText("전 종목 대상");
});

test("결과를 연 뒤 종목 정보를 기다리는 사이 검색으로 다른 종목을 열면, 늦게 온 정보는 그 선택을 덮지 않고 다음 열기는 그대로 된다", async ({ app, page }) => {
  await runSeededScreen(app, page, openScreener);
  const held = await holdSymbolInfo(page, "110030");
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
  test.use({ krxMarket: "20261105", clockStart: "20261105203000" });

  test("그날 봉까지 받고, 받은 뒤에는 빠진 관측일이 없다고 보이며, 다음 날 저녁에는 오늘 자료를 받을 수 있다고 알린다", async ({ app, page }) => {
    await page.goto("/");
    await openScreener(page);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await expect(panel(page).getByRole("status")).toContainText(/과거 이력 이어 받기[\s\S]*오늘 자료까지 받습니다\./);
    await waitForUpdateToFinish(page, "11-05(목)");
    await expect(storeLine(page)).toContainText("빠진 관측일 없음");

    await app.fake.setKrxMarket("20261106");
    await app.restart({ clockStart: "20261106203000" });
    await page.reload();
    await openScreener(page);
    await expect(storeLine(page)).toContainText("KRX 일봉 · 11-05(목)까지");
    await expect(storeLine(page)).toContainText("오늘 자료를 받을 수 있습니다");
    await storeLine(page).getByRole("button", { name: "업데이트" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await expect(storeLine(page)).toContainText("빠진 관측일 없음");
  });
});

test("최근 관측일을 채우는 동안에는 실행이 막히고, 과거를 이어 받는 동안에는 이력이 덜 찬 종목을 빼고 실행되며, 취소해도 받은 자료는 남는다", async ({ app, page }) => {
  await page.goto("/");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식" }).click();
  const dialog = editor(page, "새 조건식");
  await dialog.getByLabel("이름").fill("고가 1000일 신고가");
  await dialog.getByRole("textbox", { name: "조건 1 신고가 기간" }).fill("1000");
  await dialog.getByRole("textbox", { name: "조건 1 최근 봉 수" }).fill("300");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();

  await app.fake.delay("ka10081", 1_500);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await expect(updateBand(page)).toContainText("최근 관측일 채우기");
  await expect(runButton(page)).toBeDisabled();
  await expect(panel(page).getByText("최근 관측일을 채우는 동안에는 실행할 수 없습니다")).toBeVisible();

  await expect(updateBand(page)).toContainText("과거 이력 이어 받기", { timeout: 60_000 });
  await runButton(page).click();
  await expect(excludedLine(page)).toHaveText(/^대상 10종목 · 빠짐: 상장 기간 부족 6 · 이력 덜 참 [1-4]$/);
  await updateBand(page).getByRole("button", { name: "취소" }).click();
  await expect(updateBand(page)).toBeHidden();
  await expect(storeLine(page)).toContainText(/과거 이력 \d\/10종목/);

  await app.fake.delay("ka10081", 0);
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

test("키움이 운영자 확인이 필요한 오류를 내면 멈춘 이유를 보이고 다시 시도를 내밀지 않으며, 서버를 다시 켜면 처음부터 받는다", async ({ app, page }) => {
  await app.fake.respondWith({ apiId: "ka10081", status: 200, body: { return_code: 0, return_msg: "정상적으로 처리되었습니다" } });
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  const stopped = panel(page).getByRole("alert");
  await expect(stopped).toContainText("업데이트가 멈췄습니다");
  await expect(stopped).toContainText("최근 관측일 채우기 0/10종목에서 멈춤: 키움 응답 형식이 예상과 다릅니다");
  await expect(stopped).toContainText("운영자가 확인하고 서버를 다시 켤 때까지");
  await expect(stopped.getByRole("button", { name: "다시 시도" })).toHaveCount(0);

  await app.fake.reset();
  await app.restart();
  await page.reload();
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
});

test.describe("서버와 시계가 어긋난 브라우저", () => {
  test.use({ clockStart: null });

  const kstClock = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hourCycle: "h23" });
  const sleepUntil = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms - Date.now())));
  const retryButton = (page: Page) => panel(page).getByRole("alert").getByRole("button", { name: "다시 시도" });

  async function stoppedRetryAt(url: string): Promise<number> {
    const status = (await (await fetch(`${url}/api/screener/status`)).json()) as { update: { error: { retryAt: number } } };
    return status.update.error.retryAt;
  }

  async function expectFullReload(page: Page, check: (item: Locator) => Promise<void>) {
    const toggle = panel(page).getByRole("button", { name: "스크리너 메뉴" });
    const menu = page.getByRole("menu", { name: "스크리너 메뉴" });
    await toggle.click();
    await check(menu.getByRole("menuitem", { name: /^전체 다시 받기/ }));
    await toggle.click();
    await expect(menu).toBeHidden();
  }

  test("키움 관문이 닫혀 업데이트가 멈추면 브라우저 시계가 앞서든 뒤처지든, 기다리는 사이 바로잡혀도 관문이 열릴 때까지 다시 시도와 전체 다시 받기를 막고, 열리면 저절로 켠다", async ({ app, page, browser }) => {
    test.setTimeout(120_000);
    const ahead = page;
    const behindContext = await browser.newContext({ baseURL: app.url });
    const behind = await behindContext.newPage();
    await ahead.clock.install({ time: Date.now() + 60_000 });
    await behind.clock.install({ time: Date.now() - 60_000 });
    const retries: string[] = [];
    ahead.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/screener/update") retries.push(req.postData() ?? "");
    });

    await app.fake.respondWith({ apiId: "ka10081", status: 503, body: {} });
    await ahead.goto("/");
    await openScreener(ahead);
    await updateBand(ahead).getByRole("button", { name: "처음 받기" }).click();
    await expect(panel(ahead).getByRole("alert")).toContainText("업데이트가 멈췄습니다");
    const retryAt = await stoppedRetryAt(app.url);
    const opensFrom = `${kstClock(retryAt + 1)}부터`;
    await app.fake.reset();
    await behind.goto("/");
    await openScreener(behind);

    for (const p of [ahead, behind]) {
      await expect(retryButton(p)).toBeDisabled();
      await expect(panel(p).getByRole("alert")).toContainText(`${opensFrom} 다시 시도할 수 있습니다.`);
      await expectFullReload(p, async (item) => {
        await expect(item).toBeDisabled();
        await expect(item).toContainText(opensFrom);
      });
    }
    await ahead.clock.setSystemTime(Date.now());
    const answered = ahead.waitForResponse((r) => new URL(r.url()).pathname === "/api/symbols");
    await ahead.getByTitle(SEARCH_BUTTON_TITLE).click();
    await ahead.getByRole("dialog", { name: "종목 검색" }).getByRole("combobox", { name: "종목 검색" }).fill("삼성");
    await answered;
    await ahead.keyboard.press("Escape");
    await sleepUntil(retryAt * 1000 - 1_000);
    for (const p of [ahead, behind]) await expect(retryButton(p)).toBeDisabled({ timeout: 100 });
    expect(Date.now()).toBeLessThan(retryAt * 1000);

    for (const p of [ahead, behind]) {
      await expect(retryButton(p)).toBeEnabled({ timeout: 5_000 });
      expect(Date.now()).toBeGreaterThanOrEqual(retryAt * 1000);
      await expect(panel(p).getByRole("alert")).toContainText("다시 시도하면 남은 것만 받습니다.");
      await expectFullReload(p, async (item) => {
        await expect(item).toBeEnabled();
        await expect(item).toHaveText("전체 다시 받기…");
      });
    }

    retries.length = 0;
    await retryButton(ahead).click();
    await waitForUpdateToFinish(ahead, "11-06(금)");
    expect(retries).toEqual([JSON.stringify({ full: false })]);
    await behindContext.close();
  });

  test("기다리는 사이 오래된 응답이 늦게 와도 다시 시도와 전체 다시 받기는 안내한 시각에 저절로 켜진다", async ({ app, page }) => {
    test.setTimeout(120_000);
    let markFetched = () => {};
    let release = () => {};
    const fetched = new Promise<void>((resolve) => (markFetched = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    await page.route("**/api/bars?*", async (route) => {
      if (!holding) return route.continue();
      holding = false;
      const response = await route.fetch();
      markFetched();
      await held;
      await route.fulfill({ response });
    });

    await page.goto("/");
    await fetched;
    await app.fake.respondWith({ apiId: "ka10081", status: 503, body: {} });
    await openScreener(page);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await expect(retryButton(page)).toBeDisabled();
    const retryAt = await stoppedRetryAt(app.url);
    const opensAt = (retryAt + 1) * 1000;
    await app.fake.reset();
    await expectFullReload(page, async (item) => {
      await expect(item).toBeDisabled();
      await expect(item).toContainText(`${kstClock(retryAt + 1)}부터`);
    });

    await sleepUntil(opensAt - 10_000);
    const answered: string[] = [];
    page.on("response", (r) => {
      const { pathname } = new URL(r.url());
      if (pathname.startsWith("/api/")) answered.push(pathname);
    });
    const delivered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/bars");
    release();
    await delivered;
    await expect(retryButton(page)).toBeDisabled();

    await sleepUntil(opensAt);
    await expect(retryButton(page)).toBeEnabled({ timeout: 2_000 });
    expect(answered).toEqual(["/api/bars"]);
    await expectFullReload(page, async (item) => {
      await expect(item).toBeEnabled();
      await expect(item).toHaveText("전체 다시 받기…");
    });
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("스크리너 탭에서 찾은 행을 누르면 차트 탭으로 가서 칸의 종목만 바꾼다", async ({ app, page }) => {
    await runSeededScreen(app, page, openPhoneScreener);
    await rows(page).nth(1).getByRole("button").click();
    await expect(phoneTabs(page).getByRole("button", { name: "차트" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page)).toBeHidden();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자우 통합 일");
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  });

  test("행을 누른 뒤 종목 정보를 기다리는 사이 다른 탭으로 가면, 늦게 온 정보는 차트 탭으로 끌고 가지 않고 칸도 바꾸지 않는다", async ({ app, page }) => {
    await runSeededScreen(app, page, openPhoneScreener);
    const held = await holdSymbolInfo(page, "110030");
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
      const pick = (name: string, value: string) => dialog.getByRole("combobox", { name: `조건 1 ${name}` }).selectOption(value);
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
