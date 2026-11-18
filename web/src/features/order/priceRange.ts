import { movePrice, type PriceBounds } from "../market-window/tick";

export const EXPLORER_ROWS = 20;
const ROWS_ABOVE_CENTER = 10;

export function explorerPrices(center: number, bounds: PriceBounds): (number | null)[] {
  const start = movePrice(center, ROWS_ABOVE_CENTER, bounds);
  const prices: number[] = [start];
  while (prices.length < EXPLORER_ROWS) {
    const next = movePrice(prices[prices.length - 1]!, -1, bounds);
    if (next === prices[prices.length - 1]) break;
    prices.push(next);
  }
  return [...prices, ...Array<null>(EXPLORER_ROWS - prices.length).fill(null)];
}
