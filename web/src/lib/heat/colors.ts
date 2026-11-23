export const COLOR_RANGES = [3, 8, 15] as const;
export type ColorRange = (typeof COLOR_RANGES)[number];
export const DEFAULT_COLOR_RANGE: ColorRange = 8;

export const LEGEND_STEPS = 7;

export function rateStrength(rate: number, range: ColorRange): number {
  return Math.min(Math.abs(rate) / range, 1);
}

export function rateSide(rate: number): "up" | "down" | "flat" {
  if (rate > 0) return "up";
  if (rate < 0) return "down";
  return "flat";
}

const MAX_MIX_PERCENT = 82;
const MIN_MIX_PERCENT = 24;

export function rateFill(rate: number, range: ColorRange): string {
  const side = rateSide(rate);
  if (side === "flat") return "var(--raised)";
  return `color-mix(in srgb, var(--tile-${side}) ${mixPercent(rate, range)}%, var(--surface))`;
}

const STRONG_MIX_PERCENT = 62;

export function mixPercent(rate: number, range: ColorRange): number {
  return Math.round(MIN_MIX_PERCENT + rateStrength(rate, range) * (MAX_MIX_PERCENT - MIN_MIX_PERCENT));
}

export function needsStrongInk(rate: number, range: ColorRange): boolean {
  return rateSide(rate) !== "flat" && mixPercent(rate, range) >= STRONG_MIX_PERCENT;
}

export interface LegendStop {
  rate: number;
  fill: string;
}

export function legendStops(range: ColorRange): LegendStop[] {
  const half = (LEGEND_STEPS - 1) / 2;
  return Array.from({ length: LEGEND_STEPS }, (_, i) => {
    const rate = ((i - half) / half) * range;
    return { rate, fill: rateFill(rate, range) };
  });
}
