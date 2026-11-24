import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { SymbolKind } from "../../api/generated/SymbolKind";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isMarketOpen } from "../../chart/time";
import { formatPercent } from "../../lib/format";
import { isEtfOrEtn } from "../../lib/symbol";
import { formatWon } from "../market-window/format";
import { secondOfDay } from "../trades/tape";
import { groupKey, type PriceGroup } from "./orderRules";
import type { PendingWrite } from "./pendingWrites";

export type ProfitUnit = "won" | "percent";

export const holdingOf = (holdings: readonly TradingHolding[], code: string): TradingHolding | null => holdings.find((h) => h.code === code && h.quantity > 0) ?? null;

const profitRateChangeCenti = (holding: TradingHolding, profitChange: number): number => {
  const cost = holding.averagePrice * holding.quantity;
  return cost > 0 ? Math.round((profitChange * 10_000) / cost) : 0;
};

export function atLivePrice(holding: TradingHolding | null, lastPrice: number | null): TradingHolding | null {
  if (holding === null || lastPrice === null || lastPrice === holding.currentPrice) return holding;
  const profitChange = (lastPrice - holding.currentPrice) * holding.quantity;
  return {
    ...holding,
    currentPrice: lastPrice,
    evaluationProfit: holding.evaluationProfit + profitChange,
    profitRateCenti: holding.profitRateCenti === null ? null : holding.profitRateCenti + profitRateChangeCenti(holding, profitChange),
  };
}

export function profitText(holding: TradingHolding | null, unit: ProfitUnit): string {
  if (holding === null) return "-";
  if (unit === "percent") return holding.profitRateCenti === null ? "-" : formatPercent(holding.profitRateCenti / 100);
  const won = holding.evaluationProfit;
  return `${won > 0 ? "+" : won < 0 ? "−" : ""}${Math.abs(won).toLocaleString("ko-KR")}원`;
}

export const toggledUnit = (unit: ProfitUnit): ProfitUnit => (unit === "won" ? "percent" : "won");

export const ALL_SELLING_TEXT = "모두 매도 주문 중입니다";

const listedSellQuantity = (groups: ReadonlyMap<string, PriceGroup>, price: number): number => {
  const group = groups.get(groupKey("sell", price));
  return group !== undefined && group.orders.length > 0 ? group.quantity : 0;
};

const sendingSells = (writes: readonly PendingWrite[], code: string) =>
  writes.flatMap((write) => write.code === code && write.kind === "sending" && write.side === "sell" ? [write] : []);

const notYetListed = (groups: ReadonlyMap<string, PriceGroup>, write: { readonly price: number; readonly since: number; readonly listedWhenIn: number }, listedAt: number): boolean => {
  const listed = listedSellQuantity(groups, write.price);
  return listed > 0 && (listed < write.listedWhenIn || listedAt < write.since);
};

export const sellQuantityAtPrice = (groups: ReadonlyMap<string, PriceGroup>, writes: readonly PendingWrite[], code: string, price: number, listedAt: number): number =>
  (groups.get(groupKey("sell", price))?.quantity ?? 0) + sendingSells(writes, code).reduce((sum, write) => sum + (write.price === price && notYetListed(groups, write, listedAt) ? write.quantity : 0), 0);

export function sellOrderQuantity(groups: ReadonlyMap<string, PriceGroup>, writes: readonly PendingWrite[], code: string, listedAt: number): number {
  let quantity = 0;
  for (const group of groups.values()) if (group.side === "sell") quantity += group.quantity;
  for (const write of sendingSells(writes, code)) if (notYetListed(groups, write, listedAt)) quantity += write.quantity;
  return quantity;
}

export const remainingToSell = (holding: TradingHolding, sellOrdered: number): number => Math.min(holding.sellableQuantity, holding.quantity - sellOrdered);

export function sellableFill(holding: TradingHolding | null, sellOrdered: number): string | null {
  if (holding === null) return null;
  const remaining = remainingToSell(holding, sellOrdered);
  return remaining > 0 ? String(remaining) : null;
}

export const costTitle = (holding: TradingHolding | null): string | undefined => (holding === null ? undefined : `매입총금액 ${formatWon(Math.round(holding.averagePrice * holding.quantity))}`);

export function averageRowPrice(rowPrices: readonly (number | null)[], average: number | null): number | null {
  if (average === null || !(average > 0)) return null;
  const prices = rowPrices.filter((p): p is number => p !== null);
  if (prices.length === 0 || average < Math.min(...prices) || average > Math.max(...prices)) return null;
  return prices.reduce((best, price) => (Math.abs(price - average) < Math.abs(best - average) ? price : best));
}

const AFTER_HOURS_START_SECOND = 15 * 3600 + 30 * 60;
const AFTER_HOURS_END_SECOND = 20 * 3600;

export interface EtfOrEtnSymbol {
  readonly kind: SymbolKind;
  readonly nxtEnabled: boolean;
}

export const ETF_ETN_AFTER_HOURS_TEXT = "ETF·ETN은 15:30 뒤 거래되지 않습니다";

export function isEtfOrEtnAfterHours(now: UnixSeconds, symbol: EtfOrEtnSymbol | null): boolean {
  if (!isMarketOpen(now) || symbol === null || !isEtfOrEtn(symbol.kind) || symbol.nxtEnabled) return false;
  const second = secondOfDay(now);
  return second >= AFTER_HOURS_START_SECOND && second < AFTER_HOURS_END_SECOND;
}

export const formatFillTime = (time: string): string => (/^\d{6}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}` : time);

