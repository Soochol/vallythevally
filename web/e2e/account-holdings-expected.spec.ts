import type { Locator, Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const SAMSUNG: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const HYNIX: TradingHolding = { code: "000660", name: "SK하이닉스", quantity: 10, sellableQuantity: 10, averagePrice: 180_000, currentPrice: 180_000, evaluationProfit: 0, profitRateCenti: 0 };

const lastWatch = (scenario: Scenario): readonly string[] | undefined =>
  scenario.live.messages.flatMap((m) => (m.type === "watch" ? [m.symbols] : [])).at(-1);

const quoteOf = (symbol: string, price: number, source: "realtime" | "expected") => ({ symbol, price, change: 0, changeRate: 0, volume: 1, t: 1, source, venue: "combined" as const });

const profitOf = (page: Page, name: string): Locator => page.getByTestId("account-holding").filter({ hasText: name }).locator("b.od-figure");

test("예상체결가 시세는 보유종목 손익에 쓰지 않고 잔고 값을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [SAMSUNG, HYNIX];
  await openOrderWindow(page, scenario);
  await pollSaved(() => lastWatch(scenario)?.slice(0, 2)).toEqual([CODE, "000660"]);
  await page.getByTestId("account-tab-holdings").click();
  await expect(page.getByTestId("account-holding")).toHaveCount(2);

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 185_000, "realtime")] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 190_000, "expected")] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("0원");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 186_000, "realtime")] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+60,000원");
});
