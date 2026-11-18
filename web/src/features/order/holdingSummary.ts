import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { SymbolKind } from "../../api/generated/SymbolKind";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isMarketOpen } from "../../chart/time";
import { formatPercent } from "../../lib/format";
import { isEtfOrEtn } from "../../lib/symbol";
import { secondOfDay } from "../trades/tape";
import type { QuantityMode } from "./orderRules";

export type ProfitUnit = "won" | "percent";

export const holdingOf = (holdings: readonly TradingHolding[], code: string): TradingHolding | null => holdings.find((h) => h.code === code && h.quantity > 0) ?? null;

export function profitText(holding: TradingHolding | null, unit: ProfitUnit): string {
  if (holding === null) return "-";
  if (unit === "percent") return holding.profitRateCenti === null ? "-" : formatPercent(holding.profitRateCenti / 100);
  const won = holding.evaluationProfit;
  return `${won > 0 ? "+" : won < 0 ? "−" : ""}${Math.abs(won).toLocaleString("ko-KR")}원`;
}

export const toggledUnit = (unit: ProfitUnit): ProfitUnit => (unit === "won" ? "percent" : "won");

export interface QuantityFill {
  readonly mode: QuantityMode;
  readonly input: string;
}

export function sellableFill(holding: TradingHolding | null): QuantityFill | null {
  if (holding === null || !(holding.sellableQuantity > 0)) return null;
  return { mode: "shares", input: String(holding.sellableQuantity) };
}

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

