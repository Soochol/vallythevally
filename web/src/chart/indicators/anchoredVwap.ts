import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export type AvwapPriceSource = "hlc3" | "close";
export type AvwapQuickPreset = "open" | "low" | "high" | "vi";

export interface AnchoredVwapPoint {
  readonly t: UnixSeconds;
  readonly vwap: number;
  readonly upper1: number;
  readonly lower1: number;
  readonly upper2: number;
  readonly lower2: number;
}

export function barPriceForAvwap(bar: Bar, source: AvwapPriceSource): number {
  if (source === "close") return bar.c;
  return (bar.h + bar.l + bar.c) / 3;
}

export function computeAnchoredVwap(
  bars: readonly Bar[],
  anchorTime: UnixSeconds,
  source: AvwapPriceSource = "hlc3",
): AnchoredVwapPoint[] {
  const startIdx = bars.findIndex((b) => b.t >= anchorTime);
  if (startIdx < 0) return [];
  let cumPV = 0;
  let cumV = 0;
  let cumP2V = 0;
  const out: AnchoredVwapPoint[] = [];
  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i]!;
    const p = barPriceForAvwap(bar, source);
    const v = Math.max(0, bar.v);
    cumPV += p * v;
    cumV += v;
    cumP2V += p * p * v;
    const vwap = cumV > 0 ? cumPV / cumV : p;
    const variance = cumV > 0 ? Math.max(0, cumP2V / cumV - vwap * vwap) : 0;
    const sd = Math.sqrt(variance);
    out.push({
      t: bar.t,
      vwap,
      upper1: vwap + sd,
      lower1: vwap - sd,
      upper2: vwap + sd * 2,
      lower2: vwap - sd * 2,
    });
  }
  return out;
}

export function resolveQuickAnchor(
  bars: readonly Bar[],
  preset: AvwapQuickPreset,
  viTimes: readonly UnixSeconds[] = [],
): UnixSeconds | null {
  if (bars.length === 0) return null;
  if (preset === "open") return bars[0]!.t;
  if (preset === "low") {
    let best = bars[0]!;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.l < best.l) best = bars[i]!;
    }
    return best.t;
  }
  if (preset === "high") {
    let best = bars[0]!;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.h > best.h) best = bars[i]!;
    }
    return best.t;
  }
  if (viTimes.length === 0) return null;
  const lastVi = viTimes[viTimes.length - 1]!;
  const matched = bars.find((b) => b.t >= lastVi);
  return matched ? matched.t : null;
}
