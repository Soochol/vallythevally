import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Ranking } from "../src/api/generated/Ranking";
import type { RankingPage } from "../src/api/generated/RankingPage";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, fixedWait, pollSaved, test, windowTab, windowTabs } from "./harness";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { isRankingRequest, rankingCalls, rankingRows, serveRankings, tradeAmountRow, UNLISTED_CODE } from "./fixtures/ranking-data";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const TRADE_AMOUNT: Ranking = { kind: "tradeAmount", market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false };

function openLayout(scenario: Scenario, link: "a" | "b" | null = "a", ranking: Ranking = TRADE_AMOUNT) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, { id: "ranking", link, kind: "ranking", ranking }, ...layout.windows.filter((w) => w.kind !== "chart" && w.kind !== "ranking")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

const savedRanking = (scenario: Scenario) => {
  const window = scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.kind === "ranking");
  return window?.kind === "ranking" ? window.ranking : null;
};

const rows = (page: Page) => page.getByTestId("ranking-row");
const rowOf = (page: Page, code: string) => page.locator(`[data-testid=ranking-row][data-code="${code}"]`);
const scroller = (page: Page) => page.getByTestId("ranking-scroll");
const field = (page: Page, label: string) => page.getByRole("combobox", { name: `순위 ${label}` });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
const more = (page: Page) => page.getByTestId("ranking-more");
const stop = (page: Page) => page.getByRole("button", { name: /^멈/ });

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("ranking-window")).toBeVisible();
}

async function toBottom(box: Locator) {
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
}

async function pauseClock(page: Page) {
  await page.clock.install();
  return async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
  };
}

test("분류와 순위를 고르면 그 순위의 조건만 보이고 고른 순위·조건이 저장돼 새로고침 뒤에도 같다", async ({ page, scenario }) => {
  serveRankings(scenario);
  openLayout(scenario, null);
  await open(page);
  await expect(page.getByRole("tab", { name: "거래대금", selected: true })).toBeVisible();
  await expect(field(page, "거래소")).toHaveValue("combined");
  await expect(page.getByRole("button", { name: "관리종목 빼기" })).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("tab", { name: "등락", exact: true }).click();
  await expect(page.getByRole("tab", { name: "상승률", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "상·하한가 포함" })).toHaveAttribute("aria-pressed", "true");
  await expect(field(page, "거래대금")).toHaveValue("any");
  await field(page, "시장").selectOption("kosdaq");
  await field(page, "거래소").selectOption("krx");
  await page.getByRole("button", { name: "관리종목 빼기" }).click();
  await page.getByRole("button", { name: "상·하한가 포함" }).click();
  await page.getByRole("tab", { name: "하락률" }).click();
  await expect(field(page, "시장")).toHaveValue("kosdaq");
  await expect(field(page, "거래소")).toHaveValue("krx");
  await expect(page.getByRole("button", { name: "관리종목 빼기" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "상·하한가 포함" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("tab", { name: "호가", exact: true }).click();
  await expect(page.getByRole("tab", { name: "호가잔량", selected: true })).toBeVisible();
  await expect(field(page, "시장").locator("option")).toHaveText(["코스피", "코스닥"]);
  await expect(field(page, "시장")).toHaveValue("kosdaq");
  await expect(page.getByRole("button", { name: "상·하한가 포함" })).toHaveCount(0);

  await page.getByRole("tab", { name: "수급", exact: true }).click();
  await expect(page.getByRole("tab", { name: "투자자별 순매수", selected: true })).toBeVisible();
  await expect(field(page, "거래소")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "관리종목 빼기" })).toHaveCount(0);
  await field(page, "투자자").selectOption("foreignFirm");
  await page.getByRole("tab", { name: "프로그램" }).click();
  await expect(field(page, "시장").locator("option")).toHaveText(["코스피", "코스닥"]);
  await expect(field(page, "거래소")).toHaveValue("combined");

  await page.getByRole("tab", { name: "기타", exact: true }).click();
  await page.getByRole("tab", { name: "많이 본 종목" }).click();
  await expect(field(page, "시장")).toHaveCount(0);
  await field(page, "구간").selectOption("hour1");
  const expected: Ranking = { kind: "mostViewed", span: "hour1", excludes: { etfEtn: true, preferred: false } };
  await pollSaved(() => savedRanking(scenario)).toEqual(expected);

  await page.reload();
  await expect(page.getByRole("tab", { name: "많이 본 종목", selected: true })).toBeVisible();
  await expect(field(page, "구간")).toHaveValue("hour1");
  expect(savedRanking(scenario)).toEqual(expected);
});

test("줄을 누르면 같은 연동 색의 차트가 그 종목으로 바뀌고 ↑↓·Enter로도 되며 연동 차트가 없으면 바꾸지 않는다", async ({ page, scenario }) => {
  serveRankings(scenario);
  openLayout(scenario, "a");
  await open(page);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자 /);
  await expect(rowOf(page, "005930")).toHaveAttribute("aria-current", "true");

  await rowOf(page, "035420").click();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await expect(rowOf(page, "035420")).toHaveAttribute("aria-current", "true");
  await expect(rowOf(page, "005930")).not.toHaveAttribute("aria-current", "true");

  await page.keyboard.press("ArrowDown");
  await expect(rowOf(page, "051910")).toHaveAttribute("aria-selected", "true");
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await page.keyboard.press("Enter");
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: LG화학 /);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스 /);

  await windowTabs(page).locator('[role=tab][data-window-id="ranking"] + .link-dot').click();
  await page.getByRole("menuitemradio", { name: /^B/ }).click();
  await rowOf(page, "000270").click();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스 /);
  await expect(toast(page, "연동")).toHaveCount(0);
});

test("목록에 없는 종목 줄은 흐리게 보이고 누르거나 Enter를 눌러도 차트를 바꾸지 않고 알린다", async ({ page, scenario }) => {
  serveRankings(scenario, { rows: () => [tradeAmountRow(0), tradeAmountRow(1, 0, false), tradeAmountRow(2)] });
  openLayout(scenario, "a");
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rowOf(page, UNLISTED_CODE)).toHaveAttribute("data-listed", "false");
  await expect(rowOf(page, UNLISTED_CODE).locator(".rk-name b")).toHaveCSS("color", "rgb(120, 131, 111)");
  await expect(rowOf(page, "005930").locator(".rk-name b")).not.toHaveCSS("color", "rgb(120, 131, 111)");

  await scroller(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rowOf(page, UNLISTED_CODE)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(toast(page, "차트로 열 수 없는 종목입니다")).toBeVisible();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자 /);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await rowOf(page, UNLISTED_CODE).click();
  await expect(toast(page, "차트로 열 수 없는 종목입니다")).toBeVisible();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
});

test("끝까지 내리면 pages 2 요청이 나가 줄이 붙고 더 보기 버튼으로도 붙는다", async ({ page, scenario }) => {
  const server = serveRankings(scenario, { rows: () => rankingRows(250) });
  openLayout(scenario);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  expect(server.calls()).toEqual([{ ranking: TRADE_AMOUNT, pages: 1, trigger: "user" }]);
  await expect(page.getByTestId("ranking-foot")).toContainText("키움 ka10032 · 통합 · 100위까지");

  await toBottom(scroller(page));
  await expect(rows(page)).toHaveCount(200);
  expect(server.calls()[1]).toEqual({ ranking: TRADE_AMOUNT, pages: 2, trigger: "user" });
  await expect(rowOf(page, "100199")).toHaveCount(1);

  await more(page).click();
  await expect(rows(page)).toHaveCount(250);
  expect(server.calls()[2]).toEqual({ ranking: TRADE_AMOUNT, pages: 3, trigger: "user" });
});

test("더 받는 동안 더 보기 버튼은 받는 중이고 다시 누를 수 없다", async ({ page, scenario }) => {
  serveRankings(scenario, { rows: () => rankingRows(250) });
  openLayout(scenario);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  const held = scenario.hold((url, request) => isRankingRequest(url, request) && request.postDataJSON().pages === 2);
  await more(page).click();
  await held.received;
  await expect(more(page)).toBeDisabled();
  await expect(more(page)).toHaveText("받는 중…");
  await expect(more(page)).toHaveAttribute("aria-busy", "true");
  held.reply({ body: { rows: rankingRows(200), pages: 2, end: false, limited: false, hidden: 0, fetchedAt: 1 } satisfies RankingPage });
  await expect(rows(page)).toHaveCount(200);
  await expect(more(page)).toBeEnabled();
  expect(rankingCalls(scenario).filter((c) => c.pages === 2)).toHaveLength(1);
});

test("end가 참인 응답 뒤에는 마지막 순위입니다를 보이고 더 보기 요청이 나가지 않으며 limited와 hidden도 문구를 보인다", async ({ page, scenario }) => {
  const server = serveRankings(scenario, { rows: () => rankingRows(120), hidden: 7 });
  openLayout(scenario);
  await open(page);
  await toBottom(scroller(page));
  await expect(rows(page)).toHaveCount(120);
  await expect(page.getByTestId("ranking-end")).toHaveText("마지막 순위입니다 · 모두 120종목");
  await expect(more(page)).toHaveCount(0);
  await expect(page.getByTestId("ranking-hidden")).toHaveText("목록에 없거나 뺀 종목 7개");
  expect(server.calls().map((c) => c.pages)).toEqual([1, 2]);
  await scroller(page).evaluate((el) => { el.scrollTop = 0; });
  await toBottom(scroller(page));
  await fixedWait(page, 300, "끝난 순위에서 끝까지 내려도 요청이 나가지 않음을 보려면 그 시간이 지나야 한다");
  expect(server.calls().map((c) => c.pages)).toEqual([1, 2]);
});

test("limited 응답은 한 창에서 받는 한도를 알리고 더 보기를 멈춘다", async ({ page, scenario }) => {
  serveRankings(scenario, { rows: () => rankingRows(250), limited: true });
  openLayout(scenario);
  await open(page);
  await expect(page.getByTestId("ranking-limited")).toHaveText("한 창에서는 100위까지만 받습니다");
  await expect(more(page)).toHaveCount(0);
  await expect(page.getByTestId("ranking-end")).toHaveCount(0);
});

test("10초가 지나면 같은 pages로 갱신 요청이 나가고 응답이 표를 바꾸며 스크롤 위치와 고른 줄이 지켜진다", async ({ page, scenario }) => {
  const server = serveRankings(scenario, { rows: (version) => rankingRows(250, version) });
  openLayout(scenario);
  const pause = await pauseClock(page);
  await open(page);
  await toBottom(scroller(page));
  await expect(rows(page)).toHaveCount(200);
  await scroller(page).focus();
  await scroller(page).evaluate((el) => { el.scrollTop = 1000; });
  await page.keyboard.press("ArrowDown");
  const cursor = (await page.locator("[data-testid=ranking-row][aria-selected=true]").getAttribute("data-code"))!;
  const firstAmount = await rowOf(page, "005930").locator("td").nth(4).innerText();
  await pause();
  const before = await scroller(page).evaluate((el) => el.scrollTop);
  const status = await page.getByTestId("ranking-status").innerText();

  await page.clock.runFor(4_000);
  expect(server.calls()).toHaveLength(2);
  await page.clock.runFor(5_000);
  await expect.poll(() => server.calls().length).toBe(3);
  expect(server.calls()[2]).toEqual({ ranking: TRADE_AMOUNT, pages: 2, trigger: "refresh" });
  await expect(page.getByTestId("ranking-status")).not.toHaveText(status);
  await expect(rowOf(page, "005930").locator("td").nth(4)).not.toHaveText(firstAmount);
  await expect(rows(page)).toHaveCount(200);
  expect(Math.abs((await scroller(page).evaluate((el) => el.scrollTop)) - before)).toBeLessThan(2);
  await expect(rowOf(page, cursor)).toHaveAttribute("aria-selected", "true");
});

test("멈추기를 누르면 10초가 지나도 갱신 요청이 없고 다시 누르면 갱신된다", async ({ page, scenario }) => {
  const server = serveRankings(scenario);
  openLayout(scenario);
  const pause = await pauseClock(page);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  await pause();
  await expect(page.getByTestId("ranking-live")).toHaveAttribute("data-state", "live");
  await stop(page).click();
  await expect(stop(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ranking-live")).toHaveAttribute("data-state", "idle");
  await page.clock.runFor(30_000);
  await fixedWait(page, 300, "멈춘 창에서 갱신 요청이 나가지 않음을 보려면 그 시간이 지나야 한다");
  expect(server.calls()).toHaveLength(1);

  await more(page).click();
  await expect(rows(page)).toHaveCount(200);
  expect(server.calls()[1]).toEqual({ ranking: TRADE_AMOUNT, pages: 2, trigger: "user" });

  await stop(page).click();
  await expect(stop(page)).toHaveAttribute("aria-pressed", "false");
  await page.clock.runFor(10_000);
  await expect.poll(() => server.calls().length).toBe(3);
  expect(server.calls()[2]).toEqual({ ranking: TRADE_AMOUNT, pages: 2, trigger: "refresh" });
});

test("고르지 않은 탭에 숨은 순위 창은 갱신 요청을 보내지 않고 문서가 가려진 동안에도 보내지 않는다", async ({ page, scenario }) => {
  const server = serveRankings(scenario);
  openLayout(scenario);
  const pause = await pauseClock(page);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  await pause();

  await windowTab(page, "관심종목").click();
  await expect(page.getByTestId("ranking-window")).toHaveCount(0);
  await page.clock.runFor(30_000);
  await fixedWait(page, 300, "숨은 탭의 순위 창이 갱신 요청을 보내지 않음을 보려면 그 시간이 지나야 한다");
  expect(server.calls()).toHaveLength(1);

  await windowTab(page, "순위").click();
  await expect(rows(page)).toHaveCount(100);
  expect(server.calls()).toHaveLength(2);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("ranking-live")).toHaveAttribute("data-state", "idle");
  await page.clock.runFor(30_000);
  await fixedWait(page, 300, "가려진 문서에서 갱신 요청이 나가지 않음을 보려면 그 시간이 지나야 한다");
  expect(server.calls()).toHaveLength(2);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(100);
  await expect.poll(() => server.calls().length).toBe(3);
  expect(server.calls()[2]?.trigger).toBe("refresh");
});

test("갱신 응답을 붙잡은 사이 더 보기를 누르면 늦게 온 갱신 응답이 더 보기 결과를 덮지 않는다", async ({ page, scenario }) => {
  const server = serveRankings(scenario, { rows: () => rankingRows(250) });
  openLayout(scenario);
  const pause = await pauseClock(page);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  await pause();
  const held = scenario.hold((url, request) => isRankingRequest(url, request) && request.postDataJSON().trigger === "refresh");
  await page.clock.runFor(10_000);
  await held.received;
  await more(page).click();
  await expect(rows(page)).toHaveCount(200);
  held.reply({ body: { rows: rankingRows(100).map((row) => ({ ...row, name: `늦은 ${row.name}` })), pages: 1, end: false, limited: false, hidden: 0, fetchedAt: 1 } satisfies RankingPage });
  await fixedWait(page, 300, "붙잡았던 갱신 응답이 도착한 뒤에도 표가 그대로임을 보려면 그 시간이 지나야 한다");
  await expect(rows(page)).toHaveCount(200);
  await expect(page.getByText("늦은", { exact: false })).toHaveCount(0);
  expect(server.calls().map((c) => `${c.trigger}:${c.pages}`)).toEqual(["user:1", "refresh:1", "user:2"]);
});

test("조건을 바꾸면 pages 1 요청이 나가고 표가 맨 위로 간다", async ({ page, scenario }) => {
  const server = serveRankings(scenario);
  openLayout(scenario);
  await open(page);
  await toBottom(scroller(page));
  await expect(rows(page)).toHaveCount(200);
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "우선주 빼기" }).click();
  await expect.poll(() => server.calls().length).toBe(3);
  expect(server.calls()[2]).toEqual({ ranking: { ...TRADE_AMOUNT, excludes: { etfEtn: true, preferred: true } }, pages: 1, trigger: "user" });
  await expect(rows(page)).toHaveCount(100);
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
});

test("키움 연결 전이면 요청 없이 연결 전 상태를 보이고 연결되면 순위를 받는다", async ({ page, scenario }) => {
  serveRankings(scenario);
  openLayout(scenario);
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, state: "disconnected", message: "키움에 연결하지 않았습니다" };
  await open(page);
  await expect(page.getByTestId("ranking-window").getByText("키움 연결 전입니다")).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  expect(rankingCalls(scenario)).toHaveLength(0);
  scenario.live.link(CONNECTED_KIWOOM);
  await expect(rows(page)).toHaveCount(100);
  expect(rankingCalls(scenario)).toHaveLength(1);
});

test("서버 오류는 오류 상태와 다시 받기를 보이고 빈 목록은 순위가 비어 있습니다를 보인다", async ({ page, scenario }) => {
  const server = serveRankings(scenario);
  server.failNext();
  openLayout(scenario);
  await open(page);
  const window = page.getByTestId("ranking-window");
  await expect(window.getByRole("alert")).toContainText("키움이 응답하지 않습니다");
  await window.getByRole("button", { name: "다시 받기" }).click();
  await expect(rows(page)).toHaveCount(100);

  serveRankings(scenario, { rows: () => [] });
  await page.getByRole("button", { name: "우선주 빼기" }).click();
  await expect(window.getByText("순위가 비어 있습니다")).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
});

test("갱신이 실패해도 보이던 표는 지우지 않고 상태 줄에 실패를 알린다", async ({ page, scenario }) => {
  const server = serveRankings(scenario);
  openLayout(scenario);
  const pause = await pauseClock(page);
  await open(page);
  await expect(rows(page)).toHaveCount(100);
  await pause();
  server.failNext();
  await page.clock.runFor(10_000);
  await expect(page.getByTestId("ranking-status")).toContainText("받지 못했습니다 · 키움이 응답하지 않습니다");
  await expect(rows(page)).toHaveCount(100);
});
