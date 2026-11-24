import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingHolding } from "../../api/generated/TradingHolding";

export type LivePriceOf = (code: string) => number | null;

function rowProfitDelta(holding: TradingHolding, priceOf: LivePriceOf): number {
  const livePrice = priceOf(holding.code);
  if (livePrice === null) return 0;
  return (livePrice - holding.currentPrice) * holding.quantity;
}

function rowsProfitDelta(holdings: readonly TradingHolding[], priceOf: LivePriceOf): number {
  let total = 0;
  for (const holding of holdings) total += rowProfitDelta(holding, priceOf);
  return total;
}

export function liveTotalProfit(balance: TradingBalance, priceOf: LivePriceOf): number {
  return balance.totalProfit + rowsProfitDelta(balance.holdings, priceOf) + rowsProfitDelta(balance.creditHoldings, priceOf);
}
