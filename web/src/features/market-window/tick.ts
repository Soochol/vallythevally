import type { SymbolKind } from "../../api/generated/SymbolKind";
import { isEtfOrEtn } from "../../lib/symbol";

export type TickRule = "stock" | "etf";

const TICK_TABLE: readonly (readonly [limit: number, tick: number])[] = [
  [2_000, 1],
  [5_000, 5],
  [20_000, 10],
  [50_000, 50],
  [200_000, 100],
  [500_000, 500],
];

const TOP_TICK = 1_000;

const ETF_TICK_FROM = 2_000;

export function tickSize(price: number, rule: TickRule = "stock"): number {
  if (rule === "etf") return price < ETF_TICK_FROM ? 1 : 5;
  return TICK_TABLE.find(([limit]) => price < limit)?.[1] ?? TOP_TICK;
}

export function tickRuleOf(kind: SymbolKind | null, prices: readonly number[]): TickRule {
  const fits = (rule: TickRule): number => prices.filter((price) => price % tickSize(price, rule) === 0).length;
  const preferred: TickRule = kind !== null && isEtfOrEtn(kind) ? "etf" : "stock";
  const other: TickRule = preferred === "etf" ? "stock" : "etf";
  return fits(other) > fits(preferred) ? other : preferred;
}

export interface PriceBounds {
  readonly lower: number | null;
  readonly upper: number | null;
}

export const clampPrice = (price: number, { lower, upper }: PriceBounds): number => Math.max(lower ?? 1, Math.min(upper ?? Infinity, price));

export const withinBounds = (price: number, { lower, upper }: PriceBounds): boolean => price >= (lower ?? 1) && price <= (upper ?? Infinity);

export const stepPrice = (price: number, direction: 1 | -1, rule: TickRule = "stock"): number => (direction === 1 ? price + tickSize(price, rule) : price - tickSize(price - 1, rule));

export function movePrice(price: number, ticks: number, bounds: PriceBounds, rule: TickRule = "stock"): number {
  const direction = ticks < 0 ? -1 : 1;
  let moved = clampPrice(price, bounds);
  for (let step = 0; step < Math.abs(ticks); step++) {
    const next = clampPrice(stepPrice(moved, direction, rule), bounds);
    if (next === moved) break;
    moved = next;
  }
  return moved;
}
