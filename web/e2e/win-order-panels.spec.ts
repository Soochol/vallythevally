import type { Page } from "@playwright/test";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, DEFAULT_LAYOUT_ID, expect, test } from "./harness";
import { ACCOUNT, BASE, CODE, cellAt, openOrder, openOrderWindow, ordersOn, tradingApi, win, writesTo } from "./order-window";

const HOLDING: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 100, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const FILL: TradingExecution = { orderNo: "0000010", code: CODE, name: "삼성전자", side: "buy", quantity: 5, price: 70_000, time: "093015", venue: "krx" };

const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function lastTrade(scenario: Scenario, price: number): void {
  const request = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.venue === "combined");
  if (request?.type !== "subscribe_feed") throw new Error("체결 구독이 없습니다");
  scenario.live.emit({ type: "feed_trades", sub: request.sub, seq: 1, trades: [{ t: 1_700_000_000, price, qty: 3, venue: "krx", strength: 101.5 }] });
}

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
  await expect(page.getByTestId("order-avg-dot")).toHaveCount(1);
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
  await expect(page.getByTestId("order-avg-dot")).toHaveCount(1);
  await page.getByTestId("order-settings-button").click();
  const preset = page.getByRole("textbox", { name: "프리셋 2" });
  await preset.fill("75");
  await preset.blur();
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  await page.getByRole("checkbox", { name: "평단가 점" }).uncheck();
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").nth(1)).toHaveText("75");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("order-avg-dot")).toHaveCount(0);
  await expect.poll(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ sharePresets: [10, 75, 100, 500], averageDot: false, divider: false, rate: true });

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").nth(1)).toHaveText("75");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("order-avg-dot")).toHaveCount(0);
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.kind === "order")).toBe(true);
});
