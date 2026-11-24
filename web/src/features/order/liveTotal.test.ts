import { describe, expect, test } from "vitest";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { liveTotalProfit } from "./liveTotal";

const SAMSUNG: TradingHolding = { code: "005930", name: "삼성전자", quantity: 10, sellableQuantity: 4, averagePrice: 90_000, currentPrice: 99_000, evaluationProfit: 90_000, profitRateCenti: 1_000 };
const CREDIT_HYNIX: TradingHolding = { code: "000660", name: "신용종목", quantity: 5, sellableQuantity: 5, averagePrice: 1_000, currentPrice: 1_000, evaluationProfit: 0, profitRateCenti: 0 };
const CREDIT_SAMSUNG: TradingHolding = { ...SAMSUNG, quantity: 3, sellableQuantity: 3, evaluationProfit: 27_000 };
const BALANCE: TradingBalance = { accountRef: "synthetic-account", holdings: [SAMSUNG], creditHoldings: [CREDIT_HYNIX, CREDIT_SAMSUNG], totalPurchase: 900_000, totalEvaluation: 990_000, totalProfit: 90_000 };

const priceOf = (prices: Record<string, number>) => (code: string): number | null => prices[code] ?? null;

describe("liveTotalProfit", () => {
  test("실시간 총평가손익은 현금과 신용 줄의 가격 변동분을 조회 합계에 더한다", () => {
    expect(liveTotalProfit(BALANCE, priceOf({ "005930": 100_000, "000660": 1_200 }))).toBe(104_000);
    expect(liveTotalProfit(BALANCE, priceOf({ "000660": 1_200 }))).toBe(91_000);
    expect(liveTotalProfit(BALANCE, priceOf({}))).toBe(90_000);
  });
});
