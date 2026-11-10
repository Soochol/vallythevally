import type { Locator, Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

test.use({ krxMarket: "20261106", clockStart: "20261109100000" });

const NEXT_MORNING = { market: "20261109", clockStart: "20261110100000" };
const SCREEN_NAME = "고가 60일 신고가";
const EDITED_NAME = "고가 60일 신고가 정지 제외";

const rail = (page: Page) => page.getByRole("navigation", { name: "오른쪽 패널" });
const panel = (page: Page) => page.getByRole("complementary", { name: "스크리너" });
const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const updateBand = (page: Page) => panel(page).getByLabel("업데이트", { exact: true });
const storeLine = (page: Page) => panel(page).getByLabel("KRX 일봉 저장소");
const runButton = (page: Page) => panel(page).getByRole("button", { name: /^(실행|실행 중)$/ });
const results = (page: Page) => panel(page).getByRole("region", { name: "결과" });
const excludedLine = (page: Page) => results(page).getByText(/^대상 \d+종목 · 빠짐: /);
const rows = (page: Page) => results(page).locator("li[data-code]");
const editor = (page: Page, title: string) => page.getByRole("dialog", { name: title });

async function openScreener(page: Page) {
  await rail(page).getByRole("button", { name: /^스크리너/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function waitForUpdateToFinish(page: Page, lastDay: string) {
  await expect(panel(page).getByRole("status")).toBeVisible();
  await expect(updateBand(page)).toBeHidden({ timeout: 60_000 });
  await expect(storeLine(page)).toContainText(`KRX 일봉 · ${lastDay}까지`);
}

async function expectRows(page: Page, expected: readonly (readonly [code: string, name: string, highDate: string])[]) {
  await expect(rows(page)).toHaveCount(expected.length);
  await expect.poll(() => rows(page).evaluateAll((li) => li.map((e) => e.getAttribute("data-code")))).toEqual(expected.map(([code]) => code));
  for (const [i, [, name, highDate]] of expected.entries()) {
    const row = rows(page).nth(i);
    await expect(row.locator("b")).toHaveText(name);
    await expect(row.getByRole("button").locator("span").last()).toHaveText(highDate);
  }
}

async function expectCellOn(page: Page, row: Locator, label: string) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label} KRX 일`);
  await expect(row.getByRole("button")).toHaveAttribute("aria-current", "true");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

async function expectWatchlistOfResults(page: Page) {
  await expect(watchPanel(page).getByRole("button", { name: /^관심종목 목록: / })).toHaveAccessibleName(`관심종목 목록: ${SCREEN_NAME}`);
  await expect.poll(() => watchPanel(page).locator("li[data-code]").evaluateAll((li) => li.map((e) => e.getAttribute("data-code")))).toEqual(["110030", "110035", "110040", "110050"]);
}

const savedTo = (page: Page, path: string) => page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === path && r.ok());

test("빈 저장소를 채우고 만든 조건식으로 찾은 종목을 KRX 칸으로 훑고, 다음 날 자료 부족을 채운 뒤 고치고 지운다", async ({ app, page }) => {
  test.setTimeout(180_000);
  const barRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/bars") barRequests.push(`${url.searchParams.get("symbol")}:${url.searchParams.get("venue")}`);
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
    await expect(results(page)).toContainText("대상 9종목 · 빠짐: 상장 60일 미만 1 · 이력 덜 참 0");
    await expectRows(page, [
      ["110030", "가상분할", "당일"],
      ["110035", "가상전자우", "당일"],
      ["110040", "가상정지", "10-23"],
      ["110050", "가상관리", "10-19"],
    ]);
    await expect(rail(page).getByRole("button", { name: /^스크리너/ })).toContainText("결과 4종목");
  });

  await test.step("행을 누르면 칸이 그 종목의 KRX 일봉이 된다", async () => {
    await rows(page).nth(0).getByRole("button").click();
    await expectCellOn(page, rows(page).nth(0), "가상분할");
    expect(barRequests).toContain("110030:krx");
  });

  await test.step("↑↓로 결과를 차례로 연다", async () => {
    await page.keyboard.press("ArrowDown");
    await expectCellOn(page, rows(page).nth(1), "가상전자우");
    await page.keyboard.press("ArrowDown");
    await expectCellOn(page, rows(page).nth(2), "가상정지");
    await page.keyboard.press("ArrowUp");
    await expectCellOn(page, rows(page).nth(1), "가상전자우");
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
  await expect(excludedLine(page)).toHaveText(/^대상 10종목 · 빠짐: 상장 1,000일 미만 6 · 이력 덜 참 [1-4]$/);
  await updateBand(page).getByRole("button", { name: "취소" }).click();
  await expect(updateBand(page)).toBeHidden();
  await expect(storeLine(page)).toContainText(/과거 이력 \d\/10종목/);

  await app.fake.delay("ka10081", 0);
  await storeLine(page).getByRole("button", { name: "업데이트" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await expect(storeLine(page)).not.toContainText("과거 이력");
  await results(page).getByRole("button", { name: "새 자료로 다시 실행" }).click();
  await expect(excludedLine(page)).toHaveText("대상 10종목 · 빠짐: 상장 1,000일 미만 6 · 이력 덜 참 0");
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

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("스크리너 탭에서 찾은 행을 누르면 차트 탭으로 가서 그 종목을 KRX로 연다", async ({ app, page }) => {
    const screen = { id: "phone-screen", name: SCREEN_NAME, period: "D", exclude: ["etf"], conditions: [{ field: "high", n: 60, m: 20 }] };
    const seeded = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [screen], revision: 1 }) });
    expect(seeded.status).toBe(200);
    await page.goto("/");
    const tabs = page.getByRole("navigation", { name: "휴대폰 탭" });
    await tabs.getByRole("button", { name: "스크리너" }).click();
    await expect(panel(page).getByRole("button", { name: `조건식: ${SCREEN_NAME}` })).toBeVisible();
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(4);

    await rows(page).nth(1).getByRole("button").click();
    await expect(tabs.getByRole("button", { name: "차트" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page)).toBeHidden();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자우 KRX 일");
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  });
});
