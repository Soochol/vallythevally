import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { LinkColor } from "../src/api/generated/LinkColor";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, windowTabs } from "./harness";
<<<<<<< HEAD
import { ACCOUNT, askAtLastSnapshot, SETTINGS, BASE, CODE, cellAt, center, chipAt, commandOf, dragChip, INFO_PAGE_1, INFO_PAGE_2, INFO_PAGE_2_VALUES, infoLabels, infoPager, infoValues, openOrder, openOrderWindow, ordersOn, status, tradingApi, win, writesTo } from "./order-window";
=======
import { ACCOUNT, askAtLastSnapshot, SETTINGS, BASE, CODE, cellAt, center, chipAt, dragChip, INFO_PAGE_1, INFO_PAGE_2, INFO_PAGE_2_ENDS, INFO_PAGE_2_VALUES, infoCard, infoLabels, infoTab, infoValues, openOrder, openOrderWindow, ordersOn, status, tradingApi, win, writesTo } from "./order-window";
>>>>>>> origin/main

const HOLDING: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 100, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const FILL: TradingExecution = { orderNo: "0000010", code: CODE, name: "삼성전자", side: "buy", quantity: 5, price: 70_000, time: "093015", venue: "krx" };

const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function lastTrade(scenario: Scenario, price: number, seq = 1, qty = 3, venue: "combined" | "krx" = "combined"): void {
  const requests = scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.venue === venue);
  if (requests.length === 0) throw new Error("체결 구독이 없습니다");
  for (const request of requests) {
    if (request.type !== "subscribe_feed") continue;
    scenario.live.emit({ type: "feed_trades", sub: request.sub, seq, trades: [{ t: scenario.now / 1000 + seq, price, qty, venue: "krx", strength: 101.5 }] });
  }
}

const tops = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top * 10) / 10));
const topOf = async (locator: Locator) => (await locator.boundingBox())!.y;

test("미체결 패널이 모든 종목의 목록을 보이고 개별 취소 요청을 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), { ...openOrder("0000002", "sell", 71_000, 7), code: "000660", name: "SK하이닉스" }]);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("account-label")).toHaveText("키움 ****-**01");
  await expect(page.getByTestId("account-tab-open")).toContainText("2");
  await page.getByTestId("account-tab-open").click();
  await expect(page.getByTestId("account-panel")).toBeVisible();
  const rows = page.getByTestId("account-open-order");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("SK하이닉스");
  await rows.first().getByRole("button", { name: "취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
  expect(writesTo(api, "cancel")[0]!.header).toBe("1");
});

test("보유종목과 내 체결 패널이 목록을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING];
  api.executions = [FILL];
  await openOrderWindow(page, scenario);
  await page.getByTestId("account-tab-holdings").click();
  await expect(page.getByTestId("account-holding")).toContainText("삼성전자");
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill")).toContainText("09:30:15");
  await expect(page.getByTestId("account-fill")).toContainText("매수");
});

const FIRST_LADDER_ROW = (page: Page) => ladderRows(page).first();

test("목록 popover가 단추에 붙어 사다리를 밀지 않고 Esc·바깥 누르기·같은 단추로 닫히며 다른 단추로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  api.holdings = [HOLDING];
  api.executions = [FILL];
  await openOrderWindow(page, scenario);
  const before = await topOf(FIRST_LADDER_ROW(page));
  const panel = page.getByTestId("account-panel");
  const holdingsTab = page.getByTestId("account-tab-holdings");

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("account-holding")).toContainText("삼성전자");
  expect(await topOf(FIRST_LADDER_ROW(page))).toBe(before);
  const box = (await panel.boundingBox())!;
  const windowBox = (await win(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(360);
  expect(box.height).toBeLessThanOrEqual(240);
  expect(box.x).toBeGreaterThanOrEqual(windowBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(windowBox.x + windowBox.width);
  expect((await holdingsTab.boundingBox())!.y + (await holdingsTab.boundingBox())!.height).toBeLessThanOrEqual(box.y);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page.getByTestId("account-tab-fills").click();
  const fillsBox = (await panel.boundingBox())!;
  expect(fillsBox.x + fillsBox.width).toBeLessThanOrEqual(windowBox.x + windowBox.width);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await holdingsTab.click();
  await expect(panel).toHaveCount(0);

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await page.getByTestId("account-tab-fills").click();
  await expect(panel).toHaveAttribute("data-panel", "fills");
  await expect(page.getByTestId("account-fill")).toContainText("09:30:15");
  await expect(page.getByTestId("account-holding")).toHaveCount(0);

  await page.getByTestId("order-account").click({ position: { x: 4, y: 4 } });
  await expect(panel).toHaveCount(0);
});

test("계좌번호 가리기는 기본 켜짐이고 켠 동안 조회하지 않으며 끄면 앞 8자리가 4-4로 보이고 다시 켜면 가린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  let lookups = 0;
  scenario.on((url) => url.pathname === "/api/trading/account-number", () => { lookups += 1; return { body: { accountNumber: "1234567810" } }; });
  await openOrderWindow(page, scenario);
  const label = page.getByTestId("account-label");
  await expect(label).toHaveText("키움 ****-**01");
  await page.getByTestId("order-settings-button").click();
  const mask = page.getByRole("checkbox", { name: "계좌번호 가리기" });
  await expect(mask).toBeChecked();
  expect(lookups).toBe(0);

  await mask.uncheck();
  await expect(label).toHaveText("키움 1234-5678");
  expect(lookups).toBe(1);

  await mask.check();
  await expect(label).toHaveText("키움 ****-**01");
  expect(lookups).toBe(1);
});

test("끝 2자리를 모르는 옛 켜짐 기록이면 계좌 줄이 키움 —를 보이고 가리기를 꺼도 조회하지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  scenario.live.orders = { ...scenario.live.orders, accountTail: null };
  tradingApi(scenario);
  let lookups = 0;
  scenario.on((url) => url.pathname === "/api/trading/account-number", () => { lookups += 1; return { body: { accountNumber: "1234567810" } }; });
  await openOrderWindow(page, scenario);
  const label = page.getByTestId("account-label");
  await expect(label).toHaveText("키움 —");
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "계좌번호 가리기" }).uncheck();
  await expect(label).toHaveText("키움 —");
  expect(lookups).toBe(0);
});

test("계좌번호 조회가 실패하면 가린 모양과 실패 title을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  scenario.on((url) => url.pathname === "/api/trading/account-number", () => ({ status: 503, body: { error: { code: "internal", message: "계좌번호를 읽지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await openOrderWindow(page, scenario);
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "계좌번호 가리기" }).uncheck();
  const label = page.getByTestId("account-label");
  await expect(label).toHaveAttribute("title", "계좌번호를 읽지 못했습니다");
  await expect(label).toHaveText("키움 ****-**01");
});

test("보유 요약이 값을 보이고 평가손익을 원과 퍼센트로 바꾸며 매입수량이 매도 가능 수량을 채운다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-quantity")).toContainText("120");
  await expect(page.getByTestId("summary-quantity")).toHaveAttribute("title", "매입총금액 8,404,800원");
  await expect(page.getByTestId("summary-average")).toContainText("70,040");
  await expect(page.getByTestId("summary-profit")).toContainText("−4,800원");
  await expect(page.getByTestId("summary-buyable")).toContainText("500,000,000원");
  await page.getByTestId("summary-profit").click();
  await expect(page.getByTestId("summary-profit")).toContainText("−0.57%");
  await page.getByRole("button", { name: "금액" }).click();
  await page.getByTestId("summary-quantity").click();
  await expect(page.getByRole("textbox", { name: "수량" })).toHaveValue("100");
  await expect(page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name: "금액" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button")).toHaveText(["100만", "500만", "1000만", "5000만"]);
  await expect(page.getByTestId("ladder-mark")).toHaveCount(1);
});

test("보유가 없는 종목의 매입수량 칸에는 툴팁이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-quantity")).toContainText("-");
  await expect(page.getByTestId("summary-quantity")).not.toHaveAttribute("title", /.+/);
});

const scrollLadder = (page: Page, top: number | "end") => page.getByTestId("order-ladder").evaluate((element, target) => { element.scrollTop = target === "end" ? element.scrollHeight : target; }, top);
const fullTickCount = 431;

test("전체 호가는 상한부터 하한까지 스크롤하고 현재가 단추로 가운데에 돌아오며 다시 누르면 20행이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await expect(page.getByTestId("order-current")).toBeDisabled();
  await page.getByTestId("order-explorer").click();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "true");
  const ladder = page.getByTestId("order-ladder");
  const current = cellAt(page, "buy", BASE);
  await expect(current).toBeVisible();
  const area = (await ladder.boundingBox())!;
  const middle = (await current.boundingBox())!;
  expect(Math.abs(middle.y + middle.height / 2 - (area.y + area.height / 2))).toBeLessThan(30);
  const rendered = await ladderRows(page).count();
  expect(rendered).toBeGreaterThan(20);
  expect(rendered).toBeLessThan(fullTickCount);
  expect(await ladder.evaluate((element) => element.scrollHeight)).toBeGreaterThanOrEqual(fullTickCount * 24);

  await scrollLadder(page, "end");
  await expect(cellAt(page, "buy", 49_000)).toBeVisible();
  await scrollLadder(page, 0);
  await expect(cellAt(page, "sell", 91_000)).toBeVisible();

  await page.getByTestId("order-current").click();
  await expect(cellAt(page, "buy", 91_000)).toHaveCount(0);
  await expect(current).toBeVisible();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("order-explorer").click();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "false");
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(cellAt(page, "buy", BASE)).toBeVisible();
});

test("전체 호가에서 스크롤한 자리의 칸을 더블클릭하면 그 가격으로 신규가 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await page.getByTestId("order-explorer").click();
  await expect(cellAt(page, "buy", BASE)).toBeVisible();
  const before = await page.getByTestId("order-ladder").evaluate((element) => element.scrollTop);
  await scrollLadder(page, before + 30 * 24);
  const target = cellAt(page, "buy", 67_000);
  await expect(target).toBeVisible();
  await target.dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 67_000, quantity: 10 });
});

test("상·하한가를 받지 못하면 전체 호가 단추가 꺼지고 이유를 툴팁으로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: null, lower: null });
  await expect(page.getByTestId("order-explorer")).toBeDisabled();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("title", "상·하한가를 아직 받지 못했습니다");
});

test("평단가 점은 평단가에 가장 가까운 가격 행의 가격 칸 안 가격 숫자 왼쪽에 하나 있고 숫자 x와 행 높이는 다른 행과 같다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  const marks = page.getByTestId("ladder-mark");
  await expect(marks).toHaveCount(1);
  const marked = ladderRows(page).filter({ has: marks });
  await expect(marked).toHaveCount(1);
  await expect(marked.locator(".mw-px-num")).toHaveText("70,000");
  await expect(marked.locator(".mw-px").getByTestId("ladder-mark")).toHaveCount(1);
  const dot = (await marks.boundingBox())!;
  const markedNumber = (await marked.locator(".mw-px-num").boundingBox())!;
  expect(dot.x + dot.width).toBeLessThanOrEqual(markedNumber.x);
  const rights = await ladderRows(page).locator(".mw-px-num").evaluateAll((numbers) => numbers.map((number) => Math.round(number.getBoundingClientRect().right * 10) / 10));
  expect(rights).toEqual(Array(20).fill(rights[0]));
  const heights = await ladderRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([24]));
});

test("칩을 끄는 동안 매도 1호가가 바뀌어도 행의 가격이 움직이지 않고 놓으면 새 매도 1호가 기준이 된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  const prices = () => ladderRows(page).locator(".mw-px-num").allTextContents();
  const before = await prices();
  expect(before[0]).toBe("71,000");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_800)), false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  const movedAsks = Array.from({ length: 10 }, (_, i) => ({ price: 70_300 + 100 * i, qty: 10 + i }));
  const movedBids = Array.from({ length: 10 }, (_, i) => ({ price: 70_200 - 100 * i, qty: 20 + i }));
  await emitSingleBook(scenario, movedAsks, movedBids);
  expect(await prices()).toEqual(before);
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_800 });
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("71,200");
  await expect(ladderRows(page).locator(".mw-px-num").nth(9)).toHaveText("70,300");
});

test("계좌 실시간 메시지가 오면 조회를 다시 읽는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await page.clock.install({ time: new Date("2026-11-18T10:00:00+09:00") });
  await openOrderWindow(page, scenario);
  await page.clock.pauseAt(new Date("2026-11-18T10:00:30+09:00"));
  await expect(page.getByTestId("account-tab-open")).toContainText("0");
  const countOf = (name: string) => scenario.requests.filter((r) => new URL(r.url()).pathname === `/api/trading/${name}`).length;
  const before = { open: countOf("open-orders"), balance: countOf("balance"), executions: countOf("executions") };
  api.open = [openOrder("0000001", "buy", 70_000, 5)];
  api.holdings = [HOLDING];
  api.executions = [FILL];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.getByTestId("account-tab-open")).toContainText("1", { timeout: 500 });
    await expect(page.getByTestId("account-tab-holdings")).toContainText("1", { timeout: 500 });
    await expect(page.getByTestId("account-tab-fills")).toContainText("1", { timeout: 500 });
  }).toPass();
  expect(countOf("open-orders")).toBeGreaterThan(before.open);
  expect(countOf("balance")).toBeGreaterThan(before.balance);
  expect(countOf("executions")).toBeGreaterThan(before.executions);
});

const kstClock = (time: string) => new Date(`2026-11-18T${time}+09:00`);
const SYMBOL_INFO = { code: CODE, name: "삼성전자", kind: "common", market: "kospi", nxtEnabled: false };

test.describe("NXT 미거래 종목의 장 시간", () => {
  test("보통주는 수요일 19:50에 사다리를 그리고 안내와 세션 토글이 없으며 더블클릭이 요청을 보낸다", async ({ page, scenario }) => {
    await page.clock.install({ time: kstClock("19:50:00") });
    ordersOn(scenario);
    const api = tradingApi(scenario);
    scenario.reply(`/api/symbols/${CODE}`, { body: SYMBOL_INFO });
    await openOrderWindow(page, scenario);
    await expect(ladderRows(page)).toHaveCount(20);
    await expect(page.getByTestId("order-total-ask")).toHaveText("1,000");
    await expect(page.getByTestId("order-book-notice")).toHaveCount(0);
    await expect(win(page)).not.toContainText("호가 사다리 없음");
    await expect(page.getByRole("group", { name: "세션" })).toHaveCount(0);
    await cellAt(page, "buy", 70_000).dblclick();
    await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  });

  test("보통주는 수요일 20:30에 사다리를 그리고 안내 줄이 없다", async ({ page, scenario }) => {
    await page.clock.install({ time: kstClock("20:30:00") });
    ordersOn(scenario);
    tradingApi(scenario);
    scenario.reply(`/api/symbols/${CODE}`, { body: SYMBOL_INFO });
    await openOrderWindow(page, scenario);
    await expect(ladderRows(page)).toHaveCount(20);
    await expect(page.getByTestId("order-book-notice")).toHaveCount(0);
    await expect(win(page)).not.toContainText("장 마감 · 마지막 호가입니다");
  });

  test("ETF는 수요일 16:30에 안내 줄 없이 사다리를 그리고 더블클릭하면 요청 없이 알림이 거래 불가를 알린다", async ({ page, scenario }) => {
    await page.clock.install({ time: kstClock("16:30:00") });
    ordersOn(scenario);
    const api = tradingApi(scenario);
    scenario.reply(`/api/symbols/${CODE}`, { body: { ...SYMBOL_INFO, kind: "etf" } });
    await openOrderWindow(page, scenario);
    await expect(ladderRows(page)).toHaveCount(20);
    await expect(page.getByTestId("order-book-notice")).toHaveCount(0);
    await ladderRows(page).nth(10).locator('[data-order-cell][data-side="buy"]').dblclick();
    await expect(status(page)).toHaveText(/ETF·ETN은 15:30 뒤 거래되지 않습니다/);
    await expect(status(page)).toHaveAttribute("data-tone", "error");
    expect(api.writes).toHaveLength(0);
  });

  test("ETN은 수요일 16:30에 안내 줄 없이 사다리를 그리고 더블클릭하면 요청 없이 알림이 거래 불가를 알린다", async ({ page, scenario }) => {
    await page.clock.install({ time: kstClock("16:30:00") });
    ordersOn(scenario);
    const api = tradingApi(scenario);
    scenario.reply(`/api/symbols/${CODE}`, { body: { ...SYMBOL_INFO, kind: "etn" } });
    await openOrderWindow(page, scenario);
    await expect(ladderRows(page)).toHaveCount(20);
    await expect(page.getByTestId("order-book-notice")).toHaveCount(0);
    await ladderRows(page).nth(10).locator('[data-order-cell][data-side="buy"]').dblclick();
    await expect(status(page)).toHaveText(/ETF·ETN은 15:30 뒤 거래되지 않습니다/);
    await expect(status(page)).toHaveAttribute("data-tone", "error");
    expect(api.writes).toHaveLength(0);
  });

  test("장 마감 시각에 호가 조회가 실패하면 안내 없이 불러오지 못했다고 보인다", async ({ page, scenario }) => {
    await page.clock.install({ time: kstClock("20:30:00") });
    ordersOn(scenario);
    tradingApi(scenario);
    scenario.reply(`/api/symbols/${CODE}`, { body: SYMBOL_INFO });
    await openOrderWindow(page, scenario, false, "krx", undefined, true);
    await expect(win(page)).toContainText("호가를 불러오지 못했습니다");
    await expect(page.getByTestId("order-book-notice")).toHaveCount(0);
    await expect(page.getByTestId("price-ladder")).toHaveCount(0);
  });
});

test("설정 ⚙의 값이 창 설정으로 저장되고 새로고침해도 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button")).toHaveText(["10", "50", "100", "500"]);
  await expect(page.getByTestId("order-ladder")).toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(1);
  await page.getByTestId("order-settings-button").click();
  const preset = page.getByRole("textbox", { name: "프리셋 2", exact: true });
  await preset.fill("75");
  await preset.blur();
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  await page.getByRole("checkbox", { name: "평단가 점" }).uncheck();
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").nth(1)).toHaveText("75");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ sharePresets: [10, 75, 100, 500], amountPresets: [100, 500, 1000, 5000], averageDot: false, divider: false, rate: true, maskAccount: true });

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").nth(1)).toHaveText("75");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.kind === "order")).toBe(true);
});


const openSettings = async (page: Page) => {
  await page.getByTestId("order-settings-button").click();
  await expect(page.getByTestId("order-settings")).toBeVisible();
};

test("등락률 표시를 끄면 사다리 어느 행에도 등락률이 없고 켜면 가격이 있는 모든 행에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const rates = ladderRows(page).locator(".mw-px small");
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(rates).toHaveCount(20);
  await openSettings(page);
  await page.getByRole("checkbox", { name: "등락률 표시" }).uncheck();
  await expect(rates).toHaveCount(0);
  await page.getByRole("checkbox", { name: "등락률 표시" }).check();
  await expect(rates).toHaveCount(20);
});

test("보유가 없으면 평단가 점 옆에 안내가 보이고 보유가 있으면 점이 가격 숫자 왼쪽에 있으며 끄면 사라진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [];
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await expect(page.getByTestId("order-settings")).toContainText("보유 종목일 때 보입니다");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
});

test("보유가 있으면 안내가 없고 평단가 점이 가격 칸 안 가격 숫자 왼쪽에 있으며 끄면 점이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await expect(page.getByTestId("order-settings")).not.toContainText("보유 종목일 때 보입니다");
  const mark = page.getByTestId("price-ladder").locator(".mw-px").getByTestId("ladder-mark");
  await expect(mark).toHaveCount(1);
  const dot = (await mark.boundingBox())!;
  const number = (await ladderRows(page).filter({ has: page.getByTestId("ladder-mark") }).locator(".mw-px-num").boundingBox())!;
  expect(dot.x + dot.width).toBeLessThanOrEqual(number.x);
  await page.getByRole("checkbox", { name: "평단가 점" }).uncheck();
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
});

const stripAt = (page: Page, box: { x: number; y: number; width: number }, down: number) => page.screenshot({ clip: { x: Math.round(box.x) + 2, y: Math.round(box.y) + down, width: Math.max(1, Math.round(box.width) - 4), height: 1 } });
const hasLineOnTop = async (page: Page, box: { x: number; y: number; width: number }) => !(await stripAt(page, box, 0)).equals(await stripAt(page, box, 1));
const boxOfCell = async (locator: Locator) => (await locator.boundingBox())!;

test("구분선을 켜도 상세 정보 카드와 체결 상자 안에는 가로줄이 없고 주문·가격 칸 사이에는 있으며 끄면 어디에도 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const rowShadows = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => {
    const shadow = getComputedStyle(row).boxShadow;
    return shadow === "none" ? null : shadow;
  }));
  const heights = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  const infoCell = (row: number) => ladderRows(page).nth(row).locator(".mw-qty[data-side=bid]");
  const askCell = (row: number) => ladderRows(page).nth(row).locator(".mw-qty[data-side=ask]");
  const priceCell = (row: number) => ladderRows(page).nth(row).locator(".mw-px");
  const orderCell = (row: number) => ladderRows(page).nth(row).locator(".od-cell").first();
  const boxLayer = page.getByTestId("ladder-box-layer").locator(".mw-box");
  const underRowTop = async (cellLocator: Locator, row: number) => ({ ...(await boxOfCell(cellLocator)), y: (await boxOfCell(ladderRows(page).nth(row))).y });
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(page.getByTestId("ladder-info")).toHaveCount(7);

  const on = await rowShadows();
  expect(on[0]).toBeNull();
  const lines = on.slice(1);
  expect(lines.every((line) => line !== null)).toBe(true);
  const middle = on[10]!;
  expect(lines.filter((line) => line !== middle)).toHaveLength(18);
  expect(new Set(await heights())).toEqual(new Set([24]));

  const card = await boxOfCell(infoCard(page));
  for (const row of [1, 3, 6]) {
    const cell = await boxOfCell(infoCell(row));
    expect(cell.y).toBeGreaterThanOrEqual(card.y);
    expect(cell.y + cell.height).toBeLessThanOrEqual(card.y + card.height);
    expect(await hasLineOnTop(page, cell), `카드 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await boxOfCell(askCell(row))), `매도 잔량 칸 ${row}행`).toBe(true);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `가격 칸 ${row}행`).toBe(true);
    expect(await hasLineOnTop(page, await boxOfCell(orderCell(row))), `주문 칸 ${row}행`).toBe(true);
  }
  expect(await hasLineOnTop(page, await boxOfCell(infoCell(12))), "정보 칸이 없는 행의 매수 잔량 칸").toBe(true);
  const layer = await boxOfCell(boxLayer);
  expect(await hasLineOnTop(page, layer), "체결 상자 위 가장자리의 가운데 선").toBe(true);
  for (const row of [11, 13, 17]) {
    const rowTop = (await boxOfCell(ladderRows(page).nth(row))).y;
    expect(await hasLineOnTop(page, { x: layer.x, y: rowTop, width: layer.width }), `체결 상자 안 ${row}행 위`).toBe(false);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `${row}행 가격 칸`).toBe(true);
  }

  await openSettings(page);
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  expect((await rowShadows()).every((line) => line === null)).toBe(true);
  expect(new Set(await heights())).toEqual(new Set([24]));
  await page.keyboard.press("Escape");
  for (const row of [1, 3, 6, 13]) {
    expect(await hasLineOnTop(page, await boxOfCell(infoCell(row))), `끈 뒤 매수 잔량 칸 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await boxOfCell(askCell(row))), `끈 뒤 매도 잔량 칸 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `끈 뒤 가격 칸 ${row}행`).toBe(false);
  }
  expect(await hasLineOnTop(page, await boxOfCell(boxLayer)), "끈 뒤 체결 상자 위").toBe(false);
});

test("호가주문창도 매도 1호가가 현재가와 같으면 매도 10단·매수 10단이 가운데 선 양쪽에 모두 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", undefined, false, askAtLastSnapshot());
  const prices = ladderRows(page).locator(".mw-px-num");
  await expect(prices.nth(0)).toHaveText("70,900");
  await expect(prices.nth(9)).toHaveText("70,000");
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(prices.nth(19)).toHaveText("69,000");
  await expect(ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(10);
  await expect(ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(10);
  for (let row = 0; row < 10; row++) await expect(ladderRows(page).nth(row).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(1);
  for (let row = 10; row < 20; row++) await expect(ladderRows(page).nth(row).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");
});

test("호가 사이 빈 가격 건너뛰기를 켜면 벌어진 호가에서도 매도 10단·매수 10단이 모두 보이고 설정이 저장되며 끄면 빈 가격 행이 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", undefined, false, askAtLastSnapshot(200));
  const prices = ladderRows(page).locator(".mw-px-num");
  const bids = ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value");
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(bids).toHaveCount(8);
  await openSettings(page);
  const option = page.getByRole("checkbox", { name: "호가 사이 빈 가격 건너뛰기" });
  await expect(option).not.toBeChecked();
  await expect(option.locator("xpath=..")).toHaveAttribute("title", /10호가창에도 적용/);
  await option.check();
  await expect(prices.nth(9)).toHaveText("70,000");
  await expect(prices.nth(10)).toHaveText("69,700");
  await expect(prices.nth(19)).toHaveText("68,800");
  await expect(bids).toHaveCount(10);
  await expect(ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(10);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ skipSpreadGap: true });
  await option.uncheck();
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(bids).toHaveCount(8);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ skipSpreadGap: false });
});

test("프리셋 2에 75를 입력하고 Enter를 누르면 단추가 바로 75가 되고 새로고침해도 유지되며 틀린 값은 되돌린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await openSettings(page);
  const preset = page.getByRole("textbox", { name: "프리셋 2", exact: true });
  const buttons = page.getByRole("group", { name: "수량 프리셋" }).getByRole("button");
  await preset.fill("75");
  await expect(buttons.nth(1)).toHaveText("75");
  await preset.press("Enter");
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(buttons.nth(1)).toHaveText("75");
  await openSettings(page);
  await preset.fill("0");
  await expect(buttons.nth(1)).toHaveText("75");
  await preset.blur();
  await expect(preset).toHaveValue("75");
});

test("금액 프리셋을 바꾸면 금액 방식의 프리셋 단추가 그 값을 보이고 누르면 그 금액을 현재가로 나눈 수량이 된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await openSettings(page);
  await page.getByRole("textbox", { name: "금액 프리셋 1" }).fill("200");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "금액" }).click();
  const buttons = page.getByRole("group", { name: "수량 프리셋" }).getByRole("button");
  await expect(buttons).toHaveText(["200만", "500만", "1000만", "5000만"]);
  await buttons.first().click();
  await expect(page.getByRole("textbox", { name: "수량" })).toHaveValue("28");
});

test("설정 창은 Esc와 바깥 클릭으로 닫히고 머리에 적용 범위를 적는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await expect(page.getByTestId("order-settings")).toContainText("모든 호가주문창에 적용");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("order-settings")).toHaveCount(0);
  await openSettings(page);
  await page.getByTestId("order-total-sell").click();
  await expect(page.getByTestId("order-settings")).toHaveCount(0);
});

test("주문 입력은 두 줄로 사다리 위에, 총잔량 띠와 그 위 접수 합계 줄은 사다리 아래에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  const ladder = page.getByTestId("order-ladder");
  const ladderTop = await topOf(ladder);
  const ladderBottom = ladderTop + (await ladder.boundingBox())!.height;
  const firstLine = [page.getByRole("textbox", { name: "수량" }), page.getByRole("group", { name: "수량 방식" }), ...(await page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").all())];
  const secondLine = [page.getByTestId("order-estimate").locator(".."), page.getByTestId("order-explorer"), page.getByTestId("order-current"), page.getByTestId("order-settings-button")];
  expect(firstLine).toHaveLength(6);
  const first = await Promise.all(firstLine.map(topOf));
  const second = await Promise.all(secondLine.map(topOf));
  expect(new Set(first.map(Math.round)).size).toBe(1);
  expect(new Set(second.map(Math.round)).size).toBe(1);
  expect(second[0]!).toBeGreaterThan(first[0]!);
  const firstRow = ladderRows(page).first();
  await expect(page.getByTestId("order-status")).toHaveCount(0);
  await expect(win(page)).not.toContainText("호가 칸을 더블클릭해 주문합니다");
  const gap = (await topOf(firstRow)) - (await page.getByTestId("order-explorer").evaluate((element) => element.getBoundingClientRect().bottom));
  expect(gap).toBeLessThan(16);
  expect(await topOf(page.getByTestId("order-total-ask"))).toBeGreaterThanOrEqual(ladderBottom);
  expect(await topOf(page.getByTestId("order-total-sell"))).toBeGreaterThanOrEqual(ladderBottom);
  expect(await topOf(page.getByTestId("order-total-sell"))).toBeLessThan(await topOf(page.getByTestId("order-total-ask")));
  await expect(page.getByTestId("order-tape")).toHaveCount(0);
  await expect(page.getByTestId("order-quote")).toHaveCount(0);
});

test("금액 방식이면 같은 줄의 프리셋이 100만·500만·1000만·5000만이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  await page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name: "금액" }).click();
  const presets = page.getByRole("group", { name: "수량 프리셋" }).getByRole("button");
  await expect(presets).toHaveText(["100만", "500만", "1000만", "5000만"]);
  const input = Math.round(await topOf(page.getByRole("textbox", { name: "수량" })));
  expect((await tops(presets)).map(Math.round)).toEqual([input, input, input, input]);
});

const presetKindButton = (page: Page, name: "수량" | "금액") => page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name });
const quantityField = (page: Page) => page.getByRole("textbox", { name: "수량" });
const amountPresetButtons = (page: Page) => page.getByRole("group", { name: "수량 프리셋" }).getByRole("button");

test("금액 프리셋을 누르면 수량 칸에 현재가로 나눈 수량이 들어가고 다른 가격 칸에서도 그 수량으로 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await presetKindButton(page, "금액").click();
  await amountPresetButtons(page).first().click();
  await expect(quantityField(page)).toHaveValue("14");
  await expect(page.getByTestId("order-estimate")).toHaveText("980,000원");
  const otherPrice = BASE - 900;
  await cellAt(page, "buy", otherPrice).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: otherPrice, quantity: 14 });
});

test("금액 프리셋을 누른 뒤 현재가가 바뀌어도 수량 칸은 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await presetKindButton(page, "금액").click();
  await amountPresetButtons(page).first().click();
  await expect(quantityField(page)).toHaveValue("14");
  lastTrade(scenario, BASE + 1_000, 2);
  await expect(page.getByTestId("ladder-info").filter({ hasText: "전일대비" })).toContainText("+1,000 +1.43%");
  await expect(quantityField(page)).toHaveValue("14");
  await cellAt(page, "buy", BASE + 1_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ price: BASE + 1_000, quantity: 14 });
});

test("금액 프리셋으로 채운 수량을 손으로 고치면 고친 수량으로 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await presetKindButton(page, "금액").click();
  await amountPresetButtons(page).first().click();
  await quantityField(page).fill("20");
  await cellAt(page, "buy", BASE).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ price: BASE, quantity: 20 });
});

test("금액 방식이어도 칸 이름은 수량이고 예상 주문금액 줄에 수량을 따로 보이지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await presetKindButton(page, "금액").click();
  await amountPresetButtons(page).first().click();
  await expect(quantityField(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "금액" })).toHaveCount(0);
  await expect(page.getByTestId("order-estimate-quantity")).toHaveCount(0);
  await expect(page.getByTestId("order-estimate")).toHaveText("980,000원");
});

test("수량 칸 가운데에 숫자 아닌 글자를 쳐도 커서가 제자리에 있고 싼 종목의 큰 수량도 칸 안에 다 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, 1_000);
  const field = quantityField(page);
  await field.fill("1234");
  await field.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 2));
  await page.keyboard.type("a");
  await page.keyboard.type("5");
  await expect(field).toHaveValue("12534");
  await field.fill("1234");
  await field.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 3));
  await page.keyboard.type("a");
  await expect(field).toHaveValue("14");
  expect(await field.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(1);
  await presetKindButton(page, "금액").click();
  await amountPresetButtons(page).last().click();
  await expect(field).toHaveValue("50000");
  expect(await field.evaluate((element: HTMLInputElement) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("수량·금액 단추는 프리셋 묶음만 바꾸고 수량 칸 값은 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await quantityField(page).fill("37");
  await expect(amountPresetButtons(page)).toHaveText(["10", "50", "100", "500"]);
  await presetKindButton(page, "금액").click();
  await expect(amountPresetButtons(page)).toHaveText(["100만", "500만", "1000만", "5000만"]);
  await expect(quantityField(page)).toHaveValue("37");
  await presetKindButton(page, "수량").click();
  await expect(amountPresetButtons(page)).toHaveText(["10", "50", "100", "500"]);
  await expect(quantityField(page)).toHaveValue("37");
});

test("현재가보다 작은 금액이면 수량 칸이 0이 되고 주문은 수량을 입력하라고 막힌다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await openSettings(page);
  await page.getByRole("textbox", { name: "금액 프리셋 1" }).fill("1");
  await page.keyboard.press("Escape");
  await presetKindButton(page, "금액").click();
  await expect(amountPresetButtons(page).first()).toHaveText("1만");
  await amountPresetButtons(page).first().click();
  await expect(quantityField(page)).toHaveValue("0");
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("수량을 입력하세요");
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("상세 정보 카드가 사다리 1~9행 자리에 있고 시세 쪽에 시가·고가·저가·기준가·전일대비·거래량·거래대금 값이 맞다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(7);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(infoValues(page)).toHaveText(["69,900", "70,400", "69,400", "70,000", "0 0.00%", "123만", "864억"]);
  const rowTops = await tops(ladderRows(page));
  expect(await tops(info)).toEqual([1, 2, 3, 5, 6, 7, 8].map((row) => rowTops[row]));
  const card = (await infoCard(page).boundingBox())!;
  const price = (await ladderRows(page).first().locator(".mw-px").boundingBox())!;
  expect(card.y).toBeCloseTo(rowTops[0]!, 0);
  expect(card.height).toBe(9 * 24);
  expect(card.x).toBeGreaterThanOrEqual(price.x + price.width - 1);
  await expect(page.getByTestId("ladder-info-range")).toHaveCount(1);
});

test("종목 탭을 누르면 상·하한가·52주 범위·시가총액·PER·PBR·외국인소진율이 보이고 시세 탭으로 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);

  await page.getByTestId("ladder-info").nth(4).click();
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);

  await infoTab(page, "종목").click();
  await expect(infoTab(page, "종목")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await expect(infoValues(page)).toHaveText(INFO_PAGE_2_VALUES);
  await expect(page.getByTestId("ladder-info-ends").locator("span")).toHaveText(INFO_PAGE_2_ENDS);
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-info"))).toEqual([1, 2, 5, 6, 7].map((row) => rowTops[row]));

  await infoTab(page, "시세").click();
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("탭은 초점이 가면 화살표·Enter·Space로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("ArrowRight");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await expect(infoTab(page, "종목")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await infoTab(page, "종목").focus();
  await page.keyboard.press("Enter");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("Space");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("고른 탭은 종목이 바뀌어도 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  await infoTab(page, "종목").click();
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await expect(infoTab(page, "종목")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page).first()).toHaveText("상한가");
  await expect(infoLabels(page)).toHaveCount(6);
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
});

test("호가주문창에서 카드를 더블클릭해도 주문 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const info = page.getByTestId("ladder-info");
  await info.first().dblclick();
  await info.last().dblclick();
  await infoCard(page).dblclick({ position: { x: 3, y: 3 } });
  await infoTab(page, "시세").dblclick();
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-dragging", "");
  expect(scenario.requests.filter((request) => request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/trading/"))).toEqual([]);
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("체결강도는 11행, 체결은 12행부터 같은 top에 있고 새 체결이 맨 위이며 왼쪽 테두리와 대량 글자·막대가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const before = await tops(ladderRows(page));
  lastTrade(scenario, 70_000, 1, 3);
  lastTrade(scenario, 70_100, 2, 1_200_000);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-strength")).toContainText("101.50%");
  const rowTops = await tops(ladderRows(page));
  expect(rowTops).toEqual(before);
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual([rowTops[10]]);
  expect(await tops(page.getByTestId("ladder-trade"))).toEqual(rowTops.slice(11, 13));
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  const tradeParts = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => ({ count: row.children.length, text: row.textContent ?? "", border: getComputedStyle(row).borderLeftWidth, priceRight: row.children[0]!.getBoundingClientRect().right, qtyLeft: row.children[1]!.getBoundingClientRect().left })));
  for (const part of tradeParts) {
    expect(part.count).toBe(2);
    expect(part.border).toBe("0px");
    expect(part.text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(part.priceRight).toBeLessThanOrEqual(part.qtyLeft);
  }
  const columns = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => [row.children[0]!.getBoundingClientRect().left, row.children[1]!.getBoundingClientRect().right].map((x) => Math.round(x * 10) / 10)));
  expect(columns[0]).toEqual(columns[1]);
  lastTrade(scenario, 70_200, 3, 3);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70200");
  await expect(win(page)).not.toContainText("대량");
  await expect(page.locator(".mw-trade i")).toHaveCount(0);
});

type TradePart = { price: string | null; shown: string | null; fontSize: string; qtyScrollWidth: number; qtyClientWidth: number; qtyLeft: number; qtyRight: number; boxLeft: number; boxRight: number; priceLeft: number; priceRight: number; qtyZ: string; priceZ: string; qtyBackground: string; topAtOverlap: string | null };

const readTradeParts = (page: Page): Promise<TradePart[]> => page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
  const [price, qty] = [row.children[0]!, row.children[1]!];
  const box = row.parentElement!.getBoundingClientRect();
  const [priceRect, qtyRect] = [price.getBoundingClientRect(), qty.getBoundingClientRect()];
  const priceText = document.createRange();
  priceText.selectNodeContents(price.firstChild!);
  const priceRight = priceText.getBoundingClientRect().right;
  const overlaps = priceRight > qtyRect.left;
  const point = [qtyRect.left + 1, qtyRect.top + qtyRect.height / 2] as const;
  const stack = overlaps ? document.elementsFromPoint(point[0], point[1]) : [];
  const topAtOverlap = !overlaps ? null : !stack.includes(row) ? "offscreen" : stack[0] === qty ? "qty" : "other";
  return { price: price.textContent, shown: qty.textContent, fontSize: getComputedStyle(qty).fontSize, qtyScrollWidth: qty.scrollWidth, qtyClientWidth: qty.clientWidth, qtyLeft: qtyRect.left, qtyRight: qtyRect.right, boxLeft: box.left, boxRight: box.right, priceLeft: priceRect.left, priceRight, qtyZ: getComputedStyle(qty).zIndex, priceZ: getComputedStyle(price).zIndex, qtyBackground: getComputedStyle(qty).backgroundColor, topAtOverlap };
}));

const OVERLAP_TRADES: [number, number][] = [[70_000, 7], [70_100, 600], [70_200, 9_999], [70_300, 12_345], [70_400, 999_999], [70_500, 9_999_999]];

test("421px 호가주문창에서 수량은 쉼표 숫자 그대로 끝까지 상자 안에 보이고 겹친 가격 위에 불투명 배경으로 놓이며 열이 정렬된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  OVERLAP_TRADES.forEach(([price, qty], index) => lastTrade(scenario, price, index + 1, qty));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(OVERLAP_TRADES.length);
  const parts = await readTradeParts(page);
  expect(parts.map((part) => part.shown)).toEqual(["9,999,999", "999,999", "12,345", "9,999", "600", "7"]);
  for (const part of parts) {
    const note = JSON.stringify(part);
    expect(part.fontSize).toBe("11px");
    expect(part.qtyScrollWidth, note).toBeLessThanOrEqual(part.qtyClientWidth);
    expect(part.qtyLeft, note).toBeGreaterThanOrEqual(part.boxLeft);
    expect(part.qtyRight, note).toBeLessThanOrEqual(part.boxRight);
    expect(Number(part.qtyZ), note).toBeGreaterThan(Number(part.priceZ === "auto" ? 0 : part.priceZ));
    expect(part.qtyBackground, note).toBe("rgb(20, 25, 20)");
    if (part.topAtOverlap !== null && part.topAtOverlap !== "offscreen") expect(part.topAtOverlap, note).toBe("qty");
  }
  expect(parts.filter((part) => part.topAtOverlap === "qty").length).toBeGreaterThan(0);
  expect(new Set(parts.map((part) => Math.round(part.priceLeft * 10))).size).toBe(1);
  expect(new Set(parts.map((part) => Math.round(part.qtyRight * 10))).size).toBe(1);
  await page.screenshot({ path: "../target/ux-screens/order-421.png" });
});

test("호가주문창 체결이 8건보다 많아 스크롤바가 보일 때 체결량 오른쪽 끝과 스크롤바 왼쪽 사이가 6px 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  for (let i = 0; i < 14; i++) lastTrade(scenario, 70_000 + i, i + 1, 1_000 + i);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  const gaps = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
    const scroller = row.parentElement!;
    return scroller.getBoundingClientRect().left + scroller.clientWidth - row.children[1]!.getBoundingClientRect().right;
  }));
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(5.99);
});

test("호가주문창 체결 가격 왼쪽 끝과 같은 행 매도 주문 칸 오른쪽 끝 사이가 6px 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, 70_000, 1, 3);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  const gap = await page.evaluate(() => {
    const price = document.querySelector("[data-testid=ladder-trade]")!.children[0]!.getBoundingClientRect();
    const cells = [...document.querySelectorAll("[data-order-cell][data-side=sell]")].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.top < price.bottom && rect.bottom > price.top);
    return price.left - Math.max(...cells.map((rect) => rect.right));
  });
  expect(gap).toBeGreaterThanOrEqual(5.99);
});

test("체결 상자 아래 10행에서도 매도 주문 칸 더블클릭은 주문을 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  lastTrade(scenario, 70_000, 1, 3);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  const lowest = ladderRows(page).nth(19).locator('[data-order-cell][data-side="sell"]');
  const lowestPrice = Number(await lowest.getAttribute("data-price"));
  await lowest.dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "sell", price: lowestPrice });
});

test("호가주문창이 넓으면 가격과 수량이 겹치지 않고 둘 다 쉼표 숫자 전체로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "900px"; });
  lastTrade(scenario, 70_000, 1, 999_999);
  lastTrade(scenario, 70_100, 2, 12_345);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  const parts = await readTradeParts(page);
  expect(parts.map((part) => part.shown)).toEqual(["12,345", "999,999"]);
  for (const part of parts) {
    expect(part.priceRight).toBeLessThan(part.qtyLeft);
    expect(part.topAtOverlap).toBeNull();
  }
});

test("창을 열면 지난 체결을 pages=1로 받아 보이고 종목을 바꾸면 새 종목으로 같은 요청을 한 번 하고 그 체결을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  const tradeRequests = (code: string) => scenario.requests.map((r) => new URL(r.url())).filter((url) => url.pathname === `/api/symbols/${code}/trades`);
  expect(tradeRequests(CODE).map((url) => url.searchParams.get("pages"))).toEqual(["1"]);
  scenario.on((url) => url.pathname === "/api/symbols/000660/trades", () => ({ body: { symbol: "000660", venue: "krx", trades: [{ time: "09:31:02", price: 110_000, quantity: 5, exchange: "krx" }, { time: "09:31:01", price: 109_900, quantity: -2, exchange: "krx" }], skippedRows: 0 } }));
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "110000");
  expect(tradeRequests("000660").map((url) => url.searchParams.get("pages"))).toEqual(["1"]);
});

const SINGLE_PRICE_ASKS = [{ price: 69_600, qty: 50 }, { price: 69_700, qty: 40 }, { price: 69_800, qty: 30 }];
const SINGLE_PRICE_BIDS = [{ price: 69_500, qty: 80 }, { price: 69_400, qty: 60 }, { price: 69_300, qty: 40 }];

async function emitSingleBook(scenario: Scenario, asks: typeof SINGLE_PRICE_ASKS, bids: typeof SINGLE_PRICE_BIDS): Promise<void> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks, bids, totalAskQty: 0, totalBidQty: 0, expected: null } });
}

test("단일가 호가에서 호가주문창은 6호가만 가운데 선 위·아래에 그리고 가격 있는 행의 주문 칸만 더블클릭 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS, SINGLE_PRICE_BIDS);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(ladderRows(page).nth(7).locator(".mw-px-num")).toHaveText("69,800");
  await expect(ladderRows(page).nth(9).locator(".mw-px-num")).toHaveText("69,600");
  await expect(ladderRows(page).nth(10).locator(".mw-px-num")).toHaveText("69,500");
  await expect(ladderRows(page).nth(12).locator(".mw-px-num")).toHaveText("69,300");
  await expect(page.getByTestId("ladder-info")).toHaveCount(7);

  await ladderRows(page).nth(0).locator("[data-empty]").first().dblclick();
  await ladderRows(page).nth(19).locator("[data-empty]").first().dblclick();
  await cellAt(page, "buy", 69_500).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 69_500 });
});

test("단일가 호가에서 칩을 끄는 도중 단 가격이 바뀌어도 놓은 행의 정정 가격은 끌기 시작 때 그 행의 가격이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_500, 5)]);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS, SINGLE_PRICE_BIDS);
  await expect(chipAt(page, "buy", 69_500)).toBeVisible();
  await dragChip(page, chipAt(page, "buy", 69_500), await center(cellAt(page, "buy", 69_400)), false);
  await expect(page.getByTestId("order-ghost")).toContainText("→ 69,400원");
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS.map((l) => ({ ...l, price: l.price + 100 })), [{ price: 69_600, qty: 11 }, { price: 69_500, qty: 777 }, { price: 69_400, qty: 22 }]);
  await expect(ladderRows(page).nth(10).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("777");
  await expect(ladderRows(page).nth(10).locator(".mw-px-num")).toHaveText("69,500");
  await expect(ladderRows(page).nth(11).locator(".mw-px-num")).toHaveText("69,400");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_400 });
});

test("교차 단일가 호가에서 같은 가격이 두 행에 있어도 주문 하나는 칩 하나이고 두 행 모두 그 가격으로 주문 칸이 열린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, [{ price: 70_000, qty: 5 }, { price: 70_100, qty: 6 }, { price: 70_200, qty: 7 }], [{ price: 70_100, qty: 8 }, { price: 70_000, qty: 9 }, { price: 69_900, qty: 10 }]);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(page.getByTestId("order-chip")).toHaveCount(1);
  await expect(page.getByTestId("order-chip")).toHaveAttribute("data-price", "70000");
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await cellAt(page, "buy", 70_100).last().dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: 70_100 });
});

test("교차 호가로 카드 자리 행에 매수 잔량이 있으면 잔량이 가려지지 않고 카드는 그 행 위까지만이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks: [{ price: 70_100, qty: 50 }, { price: 70_200, qty: 40 }, { price: 70_300, qty: 30 }, { price: 70_400, qty: 20 }], bids: [{ price: 70_700, qty: 33 }, { price: 70_000, qty: 80 }], totalAskQty: 140, totalBidQty: 113, expected: null } });
  const crossed = ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: /^70,700$/ }) });
  await expect(crossed.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("33");
  const rowTop = (await crossed.boundingBox())!.y;
  const card = (await infoCard(page).boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(rowTop + 0.5);
  const info = page.getByTestId("ladder-info");
  await expect(info.filter({ hasText: "거래대금" })).toHaveCount(0);
  const crossedIndex = (await tops(ladderRows(page))).indexOf(Math.round(rowTop * 10) / 10);
  expect(card.height).toBe(crossedIndex * 24);
});

test.describe("수요일 08:55 동시호가", () => {
  test.use({ clockStart: "20261118085500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("호가주문창 상세 정보 카드에 예상체결 두 항목이 보이고 70,000원 행이 강조된다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    scenario.live.emit({ type: "feed_book", sub, book: { t: scenario.now / 1000, asks: [{ price: 70_100, qty: 50 }, { price: 70_200, qty: 40 }, { price: 70_300, qty: 30 }, { price: 70_400, qty: 20 }], bids: [{ price: 70_000, qty: 80 }], totalAskQty: 140, totalBidQty: 80, expected: { price: 70_000, qty: 300 } } });
    const info = page.getByTestId("ladder-info");
    await expect(info.and(page.locator('[data-label="예상체결가"]')).locator("b")).toHaveText("70,000");
    await expect(info.and(page.locator('[data-label="예상체결량"]')).locator("b")).toHaveText("300");
    await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(20);
    await expect(page.locator(".mw-lr[data-expected]")).toHaveCount(1);
    await expect(page.locator(".mw-lr[data-expected]")).toContainText("70,000");
  });
});

test.describe("수요일 08:35 시간외 종가 잔량", () => {
  test.use({ clockStart: "20261118083500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("호가주문창 총잔량 띠의 숫자 자리에 시간외 잔량이 보인다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    await expect(page.getByTestId("order-total-ask")).toHaveAttribute("data-source", "regular");
    scenario.live.emit({ type: "feed_after_hours", sub, totals: { t: scenario.now / 1000, askQty: 13_770, bidQty: 0 } });
    await expect(page.getByTestId("order-total-ask")).toHaveAttribute("data-source", "after-hours");
    await expect(page.getByTestId("order-total-ask")).toContainText("13,770");
    await expect(page.getByTestId("order-total-bid")).toContainText("0");
  });
});

const OTHER = "000660";
const OTHER_HOLDING: TradingHolding = { ...HOLDING, code: OTHER, name: "SK하이닉스" };
const OTHER_FILL: TradingExecution = { ...FILL, orderNo: "0000011", code: OTHER, name: "SK하이닉스", time: "101500" };

const chartWindow = (id: string, link: LinkColor | null, symbol: string): LayoutWindow => ({ id, link, kind: "chart", symbol, venue: "combined", period: "D", chartSettings: SETTINGS });
const savedSymbols = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.flatMap((w) => (w.kind === "chart" ? [[w.id, w.symbol]] : []));

function linkedArrangement(orderLink: LinkColor | null, orderSymbol?: string): (windows: LayoutWindow[]) => LayoutWindow[] {
  return (windows) => [
    chartWindow("cell-0", "a", CODE),
    chartWindow("cell-1", "a", CODE),
    chartWindow("cell-2", "b", "035420"),
    ...windows.filter((w) => w.kind !== "chart" && w.kind !== "order"),
    { id: "book", link: orderLink, kind: "book" },
    { id: "order", link: orderLink, kind: "order", venue: "krx", ...(orderSymbol ? { symbol: orderSymbol } : {}) },
  ];
}

test("내 체결 목록은 최근 체결이 맨 위다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.executions = [{ ...FILL, orderNo: "0000001", time: "090000" }, { ...FILL, orderNo: "0000003", time: "150000" }, { ...FILL, orderNo: "0000002", time: "101500" }, { ...FILL, orderNo: "0000004", time: "150000" }];
  await openOrderWindow(page, scenario);
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill").locator(".od-time")).toHaveText(["15:00:00", "15:00:00", "10:15:00", "09:00:00"]);
});

test("보유종목 이름을 누르면 같은 연동 색의 차트와 따르는 창이 모두 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", OTHER], ["cell-2", "035420"]]);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toHaveAttribute("data-symbol", OTHER);
  await expect(page.getByRole("status").filter({ hasText: "SK하이닉스" })).toHaveCount(0);
});

test("내 체결과 미체결의 종목명도 같은 방식으로 이동한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [{ ...openOrder("0000002", "sell", 71_000, 7), code: OTHER, name: "SK하이닉스" }]);
  api.executions = [OTHER_FILL];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-fills").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", OTHER], ["cell-2", "035420"]]);

  await page.getByTestId("account-tab-open").click();
  await page.getByRole("button", { name: "취소" }).waitFor();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expect(page.getByTestId("account-tab-open")).toBeVisible();
  expect(writesTo(api, "cancel")).toHaveLength(0);
});

test("연동 끔인 호가주문창에서 누르면 활성 칸 차트와 이 창이 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, (windows) => [
    chartWindow("cell-0", null, CODE),
    chartWindow("cell-1", null, "035420"),
    ...windows.filter((w) => w.kind !== "chart"),
  ]);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", "035420"]]);
});

test("고정 종목이 있는 호가주문창에서 누르면 고정이 풀리고 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement(null, CODE));
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.id === "order")).not.toHaveProperty("symbol");
});

test("종목명은 키보드로 누를 수 있고 이름이 \"…로 이동\"이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-holdings").click();
  const name = page.getByRole("button", { name: "SK하이닉스로 이동" });
  await expect(page.getByRole("button", { name: "삼성전자로 이동" })).toBeVisible();
  await name.focus();
  await expect(name).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "삼성전자로 이동" }).focus();
  await page.keyboard.press("Space");
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
});

const orderTab = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
const keptEntries = (scenario: Scenario) => scenario.documents.uiState()["orderEntries"];
const entryKeyOf = (windowId: string, code = CODE) => `${DEFAULT_LAYOUT_ID}|${windowId}|${code}`;

async function expectStart(page: Page, quantity: string, kind: "수량" | "금액") {
  await expect(quantityField(page)).toHaveValue(quantity);
  await expect(presetKindButton(page, kind)).toHaveAttribute("aria-pressed", "true");
}

async function placeKept(page: Page, api: ReturnType<typeof tradingApi>, kind: "수량" | "금액", quantity: string, count: number) {
  await presetKindButton(page, kind).click();
  await quantityField(page).fill(quantity);
  await cellAt(page, "buy", BASE).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(count);
}

test("유지 설정은 처음에 켜져 있고 수량 칸 옆에 유지 표시가 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-keep-mark")).toHaveText("유지");
  await expect(page.getByTestId("order-keep-mark")).toHaveAttribute("title", "마지막 주문 수량 유지");
  await expect(page.getByTestId("order-quantity-row").locator("label")).toHaveText("수량");
  await openSettings(page);
  const keep = page.getByRole("checkbox", { name: /마지막 주문 수량 유지/ });
  await expect(keep).toBeChecked();
  const order = await page.getByTestId("order-settings").locator("input").evaluateAll((inputs) => inputs.map((input) => input.closest("label")?.textContent ?? input.getAttribute("aria-label")));
  expect(order.slice(0, 9)).toEqual(["프리셋 1", "프리셋 2", "프리셋 3", "프리셋 4", "금액 프리셋 1", "금액 프리셋 2", "금액 프리셋 3", "금액 프리셋 4", expect.stringContaining("마지막 주문 수량 유지")]);
  await keep.uncheck();
  await expect(page.getByTestId("order-keep-mark")).toHaveCount(0);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ keepLastEntry: false });
});

test("유지가 켜져 있으면 A 종목에서 금액 방식·수량 37로 주문하고 B 종목으로 바꾸면 B는 10·수량으로 시작하고, A로 돌아오거나 새로 고치면 금액 방식과 37이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  await expectStart(page, "10", "수량");
  await placeKept(page, api, "금액", "37", 1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ quantity: 37 });
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { presetKind: "amountPresets", quantity: 37 } });
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expectStart(page, "10", "수량");
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "37", "금액");
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "37", "금액");
});

test("호가주문창 둘에서 같은 종목: 1번 창에서 37로 주문해도 2번 창은 10·수량으로 시작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await orderTab(page, "order").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.id === "order-2")).toBe(true);
  await orderTab(page, "order").click();
  await expect(win(page)).toBeVisible();
  await placeKept(page, api, "수량", "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await orderTab(page, "order-2").click();
  await expect(win(page)).toBeVisible();
  await expectStart(page, "10", "수량");
  await orderTab(page, "order").click();
  await expectStart(page, "37", "수량");
});

test("복제한 호가주문창은 원본의 기억 없이 10·수량으로 시작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await placeKept(page, api, "금액", "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { presetKind: "amountPresets", quantity: 37 } });
  await orderTab(page, "order").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await expect(win(page)).toBeVisible();
  await expectStart(page, "10", "수량");
});

test("유지를 끄면 종목을 바꿀 때 10과 수량 방식으로 시작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  await placeKept(page, api, "금액", "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
  await openSettings(page);
  await page.getByRole("checkbox", { name: /마지막 주문 수량 유지/ }).uncheck();
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expectStart(page, "10", "수량");
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "10", "수량");
  await placeKept(page, api, "금액", "5", 2);
  expect(keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
});

test("막힌 주문(한도 초과)·정정·취소는 유지 값을 바꾸지 않고 줄여 보내기는 줄인 수량을 남긴다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_800, 5)]);
  api.orderable = { cashAmount: 700_000, cashQuantity: 10 };
  await openOrderWindow(page, scenario);
  await placeKept(page, api, "수량", "7", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { presetKind: "sharePresets", quantity: 7 } });

  await dragChip(page, chipAt(page, "buy", 69_800), await center(cellAt(page, "buy", 69_900)));
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  await page.getByTestId("account-tab-open").click();
  await page.getByTestId("account-open-order").first().getByRole("button", { name: "취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(keptEntries(scenario)).toEqual({ [entryKeyOf("order")]: expect.objectContaining({ presetKind: "sharePresets", quantity: 7 }) });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await presetKindButton(page, "금액").click();
  await expect(presetKindButton(page, "금액")).toHaveAttribute("aria-pressed", "true");
  await quantityField(page).fill("11");
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("최대 10");
  expect(writesTo(api, "place")).toHaveLength(1);
  expect(keptEntries(scenario)).toEqual({ [entryKeyOf("order")]: expect.objectContaining({ presetKind: "sharePresets", quantity: 7 }) });

  await page.getByTestId("order-status-action").click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(2);
  expect(writesTo(api, "place")[1]!.body).toMatchObject({ quantity: 10 });
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { presetKind: "amountPresets", quantity: 10 } });
});

const SELL_HOLDING: TradingHolding = { ...HOLDING, quantity: 120, sellableQuantity: 120 };

test("매도 50이 걸린 120 보유 종목에서 매입수량을 누르면 70이 들어가고 칸에 남은 70이 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50), openOrder("0000002", "buy", 69_800, 40)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 70");
  await expect(page.getByTestId("summary-quantity")).toBeEnabled();
  await page.getByTestId("summary-quantity").click();
  await expect(quantityField(page)).toHaveValue("70");
  await expect(presetKindButton(page, "수량")).toHaveAttribute("aria-pressed", "true");
});

test("매도 주문이 없으면 남은 수량 표시가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000002", "buy", 69_800, 40)]).holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-remaining")).toHaveCount(0);
  await page.getByTestId("summary-quantity").click();
  await expect(quantityField(page)).toHaveValue("120");
});

test("보내는 중 매도도 뺀다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await quantityField(page).fill("10");
  await cellAt(page, "sell", 70_900).dblclick();
  await held.received;
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 60");
  await page.getByTestId("summary-quantity").click();
  await expect(quantityField(page)).toHaveValue("60");
  held.reply({ body: commandOf("sell", { price: 70_900, quantity: 10 }) });
});

test("모두 매도 주문 중이면 칸이 꺼지고 툴팁을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 120)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 0");
  await expect(page.getByTestId("summary-quantity")).toBeDisabled();
  await expect(page.getByTestId("summary-quantity")).toHaveAttribute("title", "모두 매도 주문 중입니다");
});

test("설정 단추의 아이콘이 톱니바퀴이고 단추 이름은 호가주문 설정 · 주문 경로 SOR이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "combined");
  const button = page.getByTestId("order-settings-button");
  await expect(button).toHaveAccessibleName("호가주문 설정 · 주문 경로 SOR");
  await expect(button.locator(".od-gear-route")).toHaveText("SOR");
  const teeth = await button.locator("svg path").evaluate((path) => (path.getAttribute("d")?.match(/L/g)?.length ?? 0) + 1);
  expect(teeth).toBe(24);
  await expect(button.locator("svg circle")).toHaveCount(1);
  await expect(button.locator("svg")).toHaveAttribute("width", "14");
});
