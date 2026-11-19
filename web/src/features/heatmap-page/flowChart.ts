import type { HeatmapFlowPoint } from "../../api/generated/HeatmapFlowPoint";

export const FLOW_FRAME = { width: 900, height: 360, left: 52, right: 150, top: 14, bottom: 30 } as const;

const KST_OFFSET_SECONDS = 9 * 3600;
const HOUR_SECONDS = 3600;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20] as const;
const WIDEST_STEP = 50;
const MAX_TICKS = 7;
const FLOAT_TOLERANCE = 1e-9;
const MIN_PADDING = 0.3;
const MIN_X_SPAN = 600;

export interface Extent {
  min: number;
  max: number;
}

export function rateExtent(rates: readonly number[]): Extent {
  const low = Math.min(0, ...rates);
  const high = Math.max(0, ...rates);
  const padding = Math.max((high - low) * 0.08, MIN_PADDING);
  return { min: low - padding, max: high + padding };
}

export function rateTicks({ min, max }: Extent): number[] {
  const step = STEPS.find((s) => (max - min) / s <= MAX_TICKS) ?? WIDEST_STEP;
  const first = Math.ceil(min / step - FLOAT_TOLERANCE);
  const last = Math.floor(max / step + FLOAT_TOLERANCE);
  return Array.from({ length: last - first + 1 }, (_, i) => Math.round((first + i) * step * 100) / 100);
}

export function timeExtent(times: readonly number[]): Extent {
  const min = Math.min(...times);
  const max = Math.max(...times);
  return max - min >= MIN_X_SPAN ? { min, max } : { min, max: min + MIN_X_SPAN };
}

export function hourTicks({ min, max }: Extent): number[] {
  const first = Math.ceil((min + KST_OFFSET_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS - KST_OFFSET_SECONDS;
  const ticks: number[] = [];
  for (let t = first; t <= max; t += HOUR_SECONDS) ticks.push(t);
  return ticks;
}

export function linePath(points: readonly HeatmapFlowPoint[], x: (t: number) => number, y: (rate: number) => number): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.rate).toFixed(1)}`).join(" ");
}

export function spreadLabels(ys: readonly number[], gap: number, lowest: number): number[] {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  const placed = new Array<number>(ys.length);
  let floor = -Infinity;
  for (const { y, index } of order) {
    floor = Math.max(y, floor + gap);
    placed[index] = floor;
  }
  const overflow = Math.max(0, Math.max(...placed) - lowest);
  return placed.map((y) => y - overflow);
}
