import type { Bar } from "../api/generated/Bar";

export interface Extreme {
  index: number;
  price: number;
}

export interface Extremes {
  high: Extreme;
  low: Extreme;
}

export function findExtremes(bars: readonly Pick<Bar, "h" | "l">[], from: number, to: number): Extremes | null {
  const first = Math.max(0, Math.ceil(from));
  const last = Math.min(bars.length - 1, Math.floor(to));
  if (first > last) return null;
  let high = first;
  let low = first;
  for (let i = first + 1; i <= last; i++) {
    if (bars[i]!.h >= bars[high]!.h) high = i;
    if (bars[i]!.l <= bars[low]!.l) low = i;
  }
  return { high: { index: high, price: bars[high]!.h }, low: { index: low, price: bars[low]!.l } };
}
