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

export function creditHoldingsOf(balance: TradingBalance): readonly TradingHolding[] {
  return balance.creditHoldings ?? [];
}

export function hasAnyHoldings(balance: TradingBalance | null): balance is TradingBalance {
  return balance !== null && (balance.holdings.length > 0 || creditHoldingsOf(balance).length > 0);
}

export function leasedBalanceCodes(balance: TradingBalance | undefined): string[] {
  if (balance === undefined) return [];
  const seen = new Set<string>();
  for (const holding of balance.holdings) seen.add(holding.code);
  for (const holding of creditHoldingsOf(balance)) seen.add(holding.code);
  return [...seen];
}

export function totalProfitRate(totalProfit: number, totalPurchase: number): number | null {
  if (totalPurchase <= 0) return null;
  return (totalProfit / totalPurchase) * 100;
}

export function liveTotalProfit(balance: TradingBalance, priceOf: LivePriceOf): number {
  return balance.totalProfit + rowsProfitDelta(balance.holdings, priceOf) + rowsProfitDelta(creditHoldingsOf(balance), priceOf);
}
