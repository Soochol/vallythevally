import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const KIWOOM_HOLDING: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const OTHER_HOLDING: TradingHolding = { ...KIWOOM_HOLDING, code: "000660", name: "SK하이닉스" };

const tradeSubscriptions = (scenario: Scenario) =>
  scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE ? [m.sub] : []));

async function pushTrade(scenario: Scenario, price: number): Promise<void> {
  await pollSaved(() => tradeSubscriptions(scenario).length).toBeGreaterThan(0);
  for (const sub of tradeSubscriptions(scenario)) {
    scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades: [{ t: scenario.now / 1000 + 1, price, qty: 1_000, venue: "nxt", strength: 101.5 }] });
  }
}

test("NXT 시간대처럼 키움 잔고의 현재가가 멈춰 있어도 새 체결가로 호가주문창 평가손익이 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const hynixPrice = scenario.market.quote("000660", "combined")!.price;
  tradingApi(scenario).holdings = [KIWOOM_HOLDING, { ...OTHER_HOLDING, currentPrice: hynixPrice }];
  await openOrderWindow(page, scenario);
  const profit = page.getByTestId("summary-profit");
  await expect(profit).toContainText("−4,800원");

  await pushTrade(scenario, 70_500);

  await expect(profit).toContainText("+55,200원");
  await expect(profit).toHaveAttribute("data-tone", "up");
  await profit.click();
  await expect(profit).toContainText("+0.14%");
  await page.getByTestId("account-tab-holdings").click();
  await expect(page.getByTestId("account-holding").filter({ hasText: "삼성전자" })).toContainText("+55,200원");
  await expect(page.getByTestId("account-holding").filter({ hasText: "SK하이닉스" })).toContainText("−4,800원");
});
