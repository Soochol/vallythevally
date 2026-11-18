import type { Locator, Page } from "@playwright/test";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, DEFAULT_LAYOUT_ID, expect, test } from "./harness";
import { ACCOUNT, BASE, CODE, cellAt, center, chipAt, dragChip, openOrder, openOrderWindow, ordersOn, tradingApi, win, writesTo } from "./order-window";

const HOLDING: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 100, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const FILL: TradingExecution = { orderNo: "0000010", code: CODE, name: "삼성전자", side: "buy", quantity: 5, price: 70_000, time: "093015", venue: "krx" };

const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function lastTrade(scenario: Scenario, price: number, seq = 1, qty = 3, venue: "combined" | "krx" = "combined"): void {
  const request = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.venue === venue);
  if (request?.type !== "subscribe_feed") throw new Error("체결 구독이 없습니다");
  scenario.live.emit({ type: "feed_trades", sub: request.sub, seq, trades: [{ t: 1_700_000_000 + seq, price, qty, venue: "krx", strength: 101.5 }] });
}

const tops = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top * 10) / 10));
const topOf = async (locator: Locator) => (await locator.boundingBox())!.y;

test("미체결 패널이 모든 종목의 목록을 보이고 개별 취소 요청을 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), { ...openOrder("0000002", "sell", 71_000, 7), code: "000660", name: "SK하이닉스" }]);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("account-label")).toHaveText("계좌 ··01");
  await expect(page.getByTestId("account-tab-open")).toContainText("2");
  await page.getByTestId("account-tab-open").click();
  const rows = page.getByTestId("account-open-order");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("SK하이닉스");
  await rows.first().getByRole("button", { name: "취소" }).click();
  await expect.poll(() => writesTo(api, "cancel")).toHaveLength(1);
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

test("보유 요약이 값을 보이고 평가손익을 원과 퍼센트로 바꾸며 매입수량이 매도 가능 수량을 채운다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-quantity")).toContainText("120주");
  await expect(page.getByTestId("summary-average")).toContainText("70,040");
  await expect(page.getByTestId("summary-profit")).toContainText("−4,800원");
  await expect(page.getByTestId("summary-buyable")).toContainText("500,000,000원");
  await page.getByTestId("summary-profit").click();
  await expect(page.getByTestId("summary-profit")).toContainText("−0.57%");
  await page.getByRole("button", { name: "금액" }).click();
  await page.getByTestId("summary-quantity").click();
  await expect(page.getByRole("textbox", { name: "수량" })).toHaveValue("100");
  await expect(page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name: "주" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(1);
});

test("휠로 상·하한 사이를 훑고 현재가 단추로 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await expect(page.getByTestId("order-current")).toBeDisabled();
  const ladder = page.getByTestId("order-ladder");
  const box = await ladder.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(cellAt(page, "sell", 71_500)).toBeVisible();
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(15);
  await cellAt(page, "sell", 71_500).hover();
  await expect(cellAt(page, "sell", 71_500).locator(".od-preview")).toHaveText("매도 10");
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -100);
  await expect(cellAt(page, "sell", 91_000)).toBeVisible();
  await expect(cellAt(page, "sell", 91_100)).toHaveCount(0);
  await page.getByTestId("order-current").click();
  await expect(cellAt(page, "sell", 91_000)).toHaveCount(0);
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "false");
  await expect(cellAt(page, "buy", BASE)).toBeVisible();
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

test("칩을 끄는 동안 체결이 와서 현재가가 바뀌어도 행의 가격이 움직이지 않고 놓으면 새 현재가 중심이 된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  const prices = () => ladderRows(page).locator(".mw-px-num").allTextContents();
  const before = await prices();
  expect(before[0]).toBe("71,000");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_800)), false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  lastTrade(scenario, 70_300);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,300");
  expect(await prices()).toEqual(before);
  await page.mouse.up();
  await expect.poll(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_800 });
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("71,300");
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

test("시간외를 고르면 호가 사다리 없음 빈 상태이고 정규장으로 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-total-ask")).toHaveText("1,000주");
  await expect(page.getByTestId("order-total-bid")).toHaveText("3,000주");
  await page.getByRole("group", { name: "세션" }).getByRole("button", { name: "시간외" }).click();
  await expect(win(page)).toContainText("호가 사다리 없음");
  await expect(page.getByTestId("price-ladder")).toHaveCount(0);
  await page.getByRole("group", { name: "세션" }).getByRole("button", { name: "정규장" }).click();
  await expect(ladderRows(page)).toHaveCount(20);
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
  await expect.poll(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ sharePresets: [10, 75, 100, 500], amountPresets: [100, 500, 1000, 5000], averageDot: false, divider: false, rate: true });

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
  tradingApi(scenario);
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

test("구분선을 켜면 행 사이마다 선이 있고 가운데 선은 색이 다르며 끄면 없고 행 높이는 24px로 같다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const lineColors = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => {
    const shadow = getComputedStyle(row).boxShadow;
    return shadow === "none" ? null : shadow;
  }));
  const heights = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  await expect(ladderRows(page)).toHaveCount(20);
  const on = await lineColors();
  expect(on[0]).toBeNull();
  const lines = on.slice(1);
  expect(lines.every((line) => line !== null)).toBe(true);
  expect(lines).toHaveLength(19);
  const middle = on[10]!;
  expect(lines.filter((line) => line !== middle)).toHaveLength(18);
  expect(new Set(await heights())).toEqual(new Set([24]));
  await openSettings(page);
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  expect((await lineColors()).every((line) => line === null)).toBe(true);
  expect(new Set(await heights())).toEqual(new Set([24]));
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

test("금액 프리셋을 바꾸면 금액 모드의 프리셋 단추가 그 값을 보이고 누르면 수량 칸이 그 금액이 된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await page.getByRole("textbox", { name: "금액 프리셋 1" }).fill("200");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "금액" }).click();
  const buttons = page.getByRole("group", { name: "수량 프리셋" }).getByRole("button");
  await expect(buttons).toHaveText(["200만", "500만", "1000만", "5000만"]);
  await buttons.first().click();
  await expect(page.getByRole("textbox", { name: "수량" })).toHaveValue("2000000");
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

test("주문 입력과 상태 줄은 사다리 위에, 총잔량 띠와 접수 합계는 사다리 아래에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const ladder = page.getByTestId("order-ladder");
  const ladderTop = await topOf(ladder);
  const ladderBottom = ladderTop + (await ladder.boundingBox())!.height;
  const toolbar = page.getByTestId("order-explorer");
  const quantity = page.getByRole("textbox", { name: "수량" });
  expect(await topOf(quantity)).toBeLessThan(await topOf(toolbar));
  expect(await topOf(toolbar)).toBeLessThan(await topOf(page.getByTestId("order-status")));
  expect(await topOf(page.getByTestId("order-status"))).toBeLessThan(ladderTop);
  expect(await topOf(page.getByTestId("order-estimate"))).toBeLessThan(ladderTop);
  expect(await topOf(page.getByTestId("order-total-ask"))).toBeGreaterThanOrEqual(ladderBottom);
  expect(await topOf(page.getByTestId("order-total-sell"))).toBeGreaterThan(await topOf(page.getByTestId("order-total-ask")));
  await expect(page.getByTestId("order-tape")).toHaveCount(0);
  await expect(page.getByTestId("order-quote")).toHaveCount(0);
});

test("정보 7항목이 사다리 1~7행과 같은 top에 있고 값이 맞다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(7);
  await expect(info.filter({ hasText: "현재가" })).toContainText("70,000");
  await expect(info.filter({ hasText: "상한가" })).toContainText("91,000");
  await expect(info.filter({ hasText: "하한가" })).toContainText("49,000");
  expect(await tops(info)).toEqual((await tops(ladderRows(page))).slice(0, 7));
});

test("체결강도는 13행, 최근 체결은 14행부터 같은 top에 있고 새 체결이 맨 위이며 대량 글자와 막대가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, 70_000, 1, 3, "krx");
  lastTrade(scenario, 70_100, 2, 1_200_000, "krx");
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-strength")).toContainText("101.50%");
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual([rowTops[12]]);
  expect(await tops(page.getByTestId("ladder-trade"))).toEqual(rowTops.slice(13, 15));
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  lastTrade(scenario, 70_200, 3, 3, "krx");
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70200");
  await expect(win(page)).not.toContainText("대량");
  await expect(page.locator(".mw-trade i")).toHaveCount(0);
});

test("교차 호가로 위 오른쪽 칸에 매수 잔량이 있으면 그 행은 잔량을 보이고 그 정보 항목은 보이지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let sub = "";
  await expect.poll(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks: [{ price: 70_100, qty: 50 }], bids: [{ price: 70_700, qty: 33 }, { price: 70_000, qty: 80 }], totalAskQty: 50, totalBidQty: 113, expected: null } });
  const crossed = ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: /^70,700$/ }) });
  await expect(crossed.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("33주");
  await expect(crossed.getByTestId("ladder-info")).toHaveCount(0);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(6);
  await expect(info.filter({ hasText: "하한가" })).toContainText("49,000");

});
