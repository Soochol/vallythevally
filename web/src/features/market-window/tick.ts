const TICK_TABLE: readonly (readonly [limit: number, tick: number])[] = [
  [2_000, 1],
  [5_000, 5],
  [20_000, 10],
  [50_000, 50],
  [200_000, 100],
  [500_000, 500],
];

const TOP_TICK = 1_000;

export function tickSize(price: number): number {
  return TICK_TABLE.find(([limit]) => price < limit)?.[1] ?? TOP_TICK;
}

export interface PriceBounds {
  readonly lower: number | null;
  readonly upper: number | null;
}

export const clampPrice = (price: number, { lower, upper }: PriceBounds): number => Math.max(lower ?? 1, Math.min(upper ?? Infinity, price));

export const withinBounds = (price: number, { lower, upper }: PriceBounds): boolean => price >= (lower ?? 1) && price <= (upper ?? Infinity);

export const stepPrice = (price: number, direction: 1 | -1): number => (direction === 1 ? price + tickSize(price) : price - tickSize(price - 1));

export function movePrice(price: number, ticks: number, bounds: PriceBounds): number {
  const direction = ticks < 0 ? -1 : 1;
  let moved = clampPrice(price, bounds);
  for (let step = 0; step < Math.abs(ticks); step++) {
    const next = clampPrice(stepPrice(moved, direction), bounds);
    if (next === moved) break;
    moved = next;
  }
  return moved;
}
