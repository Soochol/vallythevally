import { stepPrice, type PriceBounds, type TickRule } from "../market-window/tick";

export const LADDER_ROW_HEIGHT_PX = 24;
const OVERSCAN_ROWS = 15;
const MAX_TICKS = 20_000;

export interface RowRange {
  readonly start: number;
  readonly end: number;
}

export function fullRangePrices(bounds: PriceBounds, rule: TickRule): number[] | null {
  const { lower, upper } = bounds;
  if (lower === null || upper === null || !(lower > 0) || upper < lower) return null;
  const prices: number[] = [];
  for (let price = upper; price >= lower && prices.length < MAX_TICKS; price = stepPrice(price, -1, rule)) prices.push(price);
  return prices;
}

export function visibleRowRange(scrollTop: number, viewportHeight: number, rowCount: number, rowHeight = LADDER_ROW_HEIGHT_PX, overscan = OVERSCAN_ROWS): RowRange {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight);
  return { start: Math.min(rowCount, Math.max(0, first - overscan)), end: Math.min(rowCount, Math.max(0, last + overscan)) };
}

export function scrollTopToCenter(rowIndex: number, viewportHeight: number, rowHeight = LADDER_ROW_HEIGHT_PX): number {
  return Math.max(0, rowIndex * rowHeight + rowHeight / 2 - viewportHeight / 2);
}
