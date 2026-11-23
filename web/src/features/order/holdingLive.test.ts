import { describe, expect, it } from "vitest";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { atLivePrice, profitText } from "./holdingSummary";

const KIWOOM: TradingHolding = { code: "009150", name: "삼성전기", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: 70_000, evaluationProfit: -4_800, profitRateCenti: -57 };

describe("실시간 현재가로 맞춘 평가손익", () => {
  it("실시간 현재가가 키움 현재가보다 오르면 차이 × 보유수량만큼 평가손익과 수익률이 오른다", () => {
    const live = atLivePrice(KIWOOM, 70_500);
    expect(live).toEqual({ ...KIWOOM, currentPrice: 70_500, evaluationProfit: 55_200, profitRateCenti: 14 });
    expect(profitText(live, "won")).toBe("+55,200원");
    expect(profitText(live, "percent")).toBe("+0.14%");
  });

  it("실시간 현재가가 키움 현재가보다 내리면 차이 × 보유수량만큼 평가손익과 수익률이 내린다", () => {
    const live = atLivePrice(KIWOOM, 69_500);
    expect(live).toEqual({ ...KIWOOM, currentPrice: 69_500, evaluationProfit: -64_800, profitRateCenti: -128 });
    expect(profitText(live, "won")).toBe("−64,800원");
    expect(profitText(live, "percent")).toBe("−1.28%");
  });

  it("실시간 현재가가 없거나 키움 현재가와 같으면 키움 값을 그대로 쓴다", () => {
    expect(atLivePrice(KIWOOM, null)).toEqual(KIWOOM);
    expect(atLivePrice(KIWOOM, 70_000)).toEqual(KIWOOM);
    expect(atLivePrice(null, 70_500)).toBeNull();
  });

  it("키움 수익률이 없으면 수익률은 없는 채로 평가손익만 맞춘다", () => {
    expect(atLivePrice({ ...KIWOOM, profitRateCenti: null }, 70_500)).toEqual({ ...KIWOOM, currentPrice: 70_500, evaluationProfit: 55_200, profitRateCenti: null });
  });
});
