import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { HexColor } from "../../lib/colors";

export const DEPTH_GAMMA = 0.65;
export const ALPHA_STEPS = 32;

export type DepthLevels = readonly (readonly [number, number])[];

export interface DepthFrame {
  from: number;
  to: number;
  width: number;
  point(index: number): QuoteDepthPoint | undefined;
  x(index: number): number | null;
  y(price: number): number | null;
}

export interface DepthStyle {
  ask: HexColor;
  bid: HexColor;
  maxOpacity: number;
  topLevels: number | null;
}

const halfStepCache = new WeakMap<QuoteDepthPoint, number>();
const topLevelsCache = new WeakMap<QuoteDepthPoint, Map<number, { asks: DepthLevels; bids: DepthLevels }>>();
const buckets: number[][] = Array.from({ length: ALPHA_STEPS * 2 }, () => []);
const visiblePoints: QuoteDepthPoint[] = [];
const visibleIndices: number[] = [];
const yCache = new Map<number, number | null>();

export function levelAlpha(qty: number, max: number, maxOpacity: number): number {
  if (qty <= 0 || max <= 0 || maxOpacity <= 0) return 0;
  const ratio = qty >= max ? 1 : qty / max;
  return maxOpacity * ratio ** DEPTH_GAMMA;
}

export function topLevels(levels: DepthLevels, count: number | null): DepthLevels {
  if (count === null || levels.length <= count) return levels;
  if (count <= 0) return [];
  return levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => b.level[1] - a.level[1] || a.index - b.index)
    .slice(0, count)
    .map((item) => item.level);
}

export function visibleMax(points: Iterable<QuoteDepthPoint | undefined>): number {
  let max = 0;
  for (const point of points) {
    if (!point) continue;
    for (let i = 0; i < point.asks.length; i++) {
      const qty = point.asks[i]![1];
      if (qty > max) max = qty;
    }
    for (let i = 0; i < point.bids.length; i++) {
      const qty = point.bids[i]![1];
      if (qty > max) max = qty;
    }
  }
  return max;
}

export function halfStep(point: QuoteDepthPoint): number {
  const prices: number[] = [];
  for (let i = 0; i < point.asks.length; i++) prices.push(point.asks[i]![0]);
  for (let i = 0; i < point.bids.length; i++) prices.push(point.bids[i]![0]);
  if (prices.length < 2) return 0.5;
  prices.sort((a, b) => a - b);
  let minDiff = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff > 0 && diff < minDiff) minDiff = diff;
  }
  return Number.isFinite(minDiff) ? minDiff / 2 : 0.5;
}

function cachedHalfStep(point: QuoteDepthPoint): number {
  const known = halfStepCache.get(point);
  if (known !== undefined) return known;
  const computed = halfStep(point);
  halfStepCache.set(point, computed);
  return computed;
}

function cachedSides(point: QuoteDepthPoint, count: number | null): { asks: DepthLevels; bids: DepthLevels } {
  if (count === null) return point;
  let byCount = topLevelsCache.get(point);
  if (!byCount) {
    byCount = new Map();
    topLevelsCache.set(point, byCount);
  }
  const known = byCount.get(count);
  if (known) return known;
  const computed = { asks: topLevels(point.asks, count), bids: topLevels(point.bids, count) };
  byCount.set(count, computed);
  return computed;
}

function cachedY(frame: DepthFrame, price: number): number | null {
  if (yCache.has(price)) return yCache.get(price)!;
  const coord = frame.y(price);
  yCache.set(price, coord);
  return coord;
}

function parseRgb(hex: HexColor): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function collectSide(
  levels: DepthLevels,
  sideOffset: number,
  left: number,
  half: number,
  max: number,
  maxOpacity: number,
  frame: DepthFrame,
): void {
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const qty = level[1];
    if (qty <= 0) continue;
    const alpha = levelAlpha(qty, max, maxOpacity);
    if (alpha <= 0) continue;
    const step = Math.max(1, Math.min(ALPHA_STEPS, Math.ceil((alpha / maxOpacity) * ALPHA_STEPS)));
    const price = level[0];
    const yTop = cachedY(frame, price + half);
    const yBottom = cachedY(frame, price - half);
    if (yTop === null || yBottom === null) continue;
    const top = yTop < yBottom ? yTop : yBottom;
    const diff = yBottom > yTop ? yBottom - yTop : yTop - yBottom;
    const height = diff > 1 ? diff : 1;
    buckets[sideOffset + step - 1]!.push(left, top, height);
  }
}

export function drawDepth(
  ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">,
  frame: DepthFrame,
  style: DepthStyle,
): void {
  if (frame.from > frame.to || style.maxOpacity <= 0) return;
  try {
    let max = 0;
    for (let i = frame.from; i <= frame.to; i++) {
      const point = frame.point(i);
      if (!point) continue;
      visiblePoints.push(point);
      visibleIndices.push(i);
      for (let j = 0; j < point.asks.length; j++) {
        const qty = point.asks[j]![1];
        if (qty > max) max = qty;
      }
      for (let j = 0; j < point.bids.length; j++) {
        const qty = point.bids[j]![1];
        if (qty > max) max = qty;
      }
    }
    if (max <= 0) return;
    const halfWidth = frame.width / 2;
    for (let i = 0; i < visiblePoints.length; i++) {
      const point = visiblePoints[i]!;
      const x = frame.x(visibleIndices[i]!);
      if (x === null) continue;
      const left = x - halfWidth;
      const half = cachedHalfStep(point);
      const sides = cachedSides(point, style.topLevels);
      collectSide(sides.asks, 0, left, half, max, style.maxOpacity, frame);
      collectSide(sides.bids, ALPHA_STEPS, left, half, max, style.maxOpacity, frame);
    }
    const askRgb = parseRgb(style.ask);
    const bidRgb = parseRgb(style.bid);
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b]!;
      if (bucket.length === 0) continue;
      const rgb = b < ALPHA_STEPS ? askRgb : bidRgb;
      const step = (b % ALPHA_STEPS) + 1;
      const alpha = (style.maxOpacity * step) / ALPHA_STEPS;
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
      for (let j = 0; j < bucket.length; j += 3) {
        ctx.fillRect(bucket[j]!, bucket[j + 1]!, frame.width, bucket[j + 2]!);
      }
    }
  } finally {
    visiblePoints.length = 0;
    visibleIndices.length = 0;
    yCache.clear();
    for (let b = 0; b < buckets.length; b++) buckets[b]!.length = 0;
  }
}
