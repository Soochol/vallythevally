import { describe, expect, test } from "vitest";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { hasAnyHoldings, leasedBalanceCodes, liveTotalProfit, totalProfitRate } from "./liveTotal";

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

  test("총매입금액이 0이면 수익률이 없고 양수면 총평가손익 비율을 돌려준다", () => {
    expect(totalProfitRate(30_000, 0)).toBeNull();
    expect(totalProfitRate(30_000, 2_000_000)).toBeCloseTo(1.5, 5);
  });

  test("구독 종목 목록은 현금 뒤 신용 순서이고 겹치면 한 번만 든다", () => {
    expect(leasedBalanceCodes(BALANCE)).toEqual(["005930", "000660"]);
    expect(leasedBalanceCodes(undefined)).toEqual([]);
  });

  test("현금이나 신용 보유가 하나라도 있어야 보유 있음으로 본다", () => {
    expect(hasAnyHoldings(null)).toBe(false);
    expect(hasAnyHoldings({ ...BALANCE, holdings: [], creditHoldings: [] })).toBe(false);
    expect(hasAnyHoldings({ ...BALANCE, holdings: [], creditHoldings: [CREDIT_HYNIX] })).toBe(true);
  });
});
