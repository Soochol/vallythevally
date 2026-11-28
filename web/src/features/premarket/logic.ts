import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import type { PreMarketPoint } from "../../api/generated/PreMarketPoint";

export const PREMARKET_EARLIEST_SEC = 8 * 3600 + 30 * 60;
export const PREMARKET_START_SEC = 8 * 3600 + 50 * 60;
export const PREMARKET_END_SEC = 9 * 3600;
export const SPOOF_WATCH_START_SEC = 8 * 3600 + 58 * 60;
export const MAX_COMPARE_DATES = 10;
export const BAND_SAMPLE_STEP_SEC = 30;

export const CHART_VIEW_W = 940;
export const CHART_VIEW_H = 400;
export const CHART_PAD_LEFT = 54;
export const CHART_PAD_RIGHT = 62;
export const CHART_PAD_TOP = 18;
export const CHART_PAD_BOTTOM = 26;
export const CHART_PANEL_GAP = 22;

export type CompareRange = 5 | 10;
export type VolumeUnit = "qty" | "turnover";
export type BreakoutState = "above" | "below" | "inside" | "solo";

export interface HistoricalBandPoint {
  readonly secOfDay: number;
  readonly minPct: number;
  readonly p25Pct: number;
  readonly medianPct: number;
  readonly p75Pct: number;
  readonly maxPct: number;
  readonly minVol: number;
  readonly p25Vol: number;
  readonly medianVol: number;
  readonly p75Vol: number;
  readonly maxVol: number;
  readonly avgVol: number;
}

export interface BreakoutSegment {
  readonly key: string;
  readonly state: BreakoutState;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly excessPoly: string | null;
}

export interface ChartGeometry {
  readonly startSec: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly priceBottom: number;
  readonly volTop: number;
  readonly plotBottom: number;
  readonly minPct: number;
  readonly maxPct: number;
  readonly maxVol: number;
  readonly xOf: (sec: number) => number;
  readonly yOf: (pct: number) => number;
  readonly yVolOf: (vol: number) => number;
  readonly yTicks: readonly number[];
  readonly xTicks: readonly number[];
}

export function valueTone(value: number | null | undefined): "up" | "down" | "flat" {
  if (value === null || value === undefined || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export function formatSecOfDay(sec: number, includeSeconds = true): string {
  const clamped = Math.max(0, Math.min(86399, Math.round(sec)));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  if (!includeSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(s).padStart(2, "0")}`;
}

export function formatSignedPct(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("ko-KR");
}

export function formatQty(qty: number, compact = false): string {
  if (!Number.isFinite(qty) || qty < 0) return "—";
  const suffix = compact ? "" : "주";
  if (qty === 0) return `0${suffix}`;
  if (qty >= 10_000) return `${(qty / 10_000).toFixed(1)}만${suffix}`;
  return `${Math.round(qty).toLocaleString("ko-KR")}${suffix}`;
}

export function formatTurnover(millionWon: number): string {
  if (!Number.isFinite(millionWon) || millionWon <= 0) return "—";
  if (millionWon >= 100) return `${(millionWon / 100).toFixed(1)}억`;
  return `${Math.round(millionWon).toLocaleString("ko-KR")}백만`;
}

export function pointVolumeValue(point: PreMarketPoint, unit: VolumeUnit): number {
  return unit === "qty" ? point.expectedQty : point.expectedTurnoverMillionWon;
}

export function formatVolumeValue(value: number, unit: VolumeUnit, compact = false): string {
  if (unit === "qty") return formatQty(value, compact);
  if (value <= 0) return compact ? "0" : "0억";
  return formatTurnover(value);
}

export function selectRangeDates(available: readonly string[], range: CompareRange): string[] {
  const limit = Math.min(range, MAX_COMPARE_DATES);
  if (available.length <= limit) return [...available];
  return available.slice(available.length - limit);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo]!;
  const hiVal = sorted[hi]!;
  return loVal + (hiVal - loVal) * (pos - lo);
}

export function resolveChartStartSec(series: readonly PreMarketDaySeries[]): number {
  let minSec = PREMARKET_START_SEC;
  for (const s of series) {
    for (const pt of s.points) {
      if (pt.secOfDay < minSec) minSec = pt.secOfDay;
    }
  }
  if (minSec >= PREMARKET_START_SEC) return PREMARKET_START_SEC;
  const floored = Math.floor(minSec / 300) * 300;
  return Math.max(PREMARKET_EARLIEST_SEC, floored);
}

function buildXTicks(startSec: number): readonly number[] {
  if (startSec >= PREMARKET_START_SEC) {
    return [
      8 * 3600 + 50 * 60,
      8 * 3600 + 52 * 60,
      8 * 3600 + 54 * 60,
      8 * 3600 + 56 * 60,
      SPOOF_WATCH_START_SEC,
      PREMARKET_END_SEC,
    ];
  }
  const span = PREMARKET_END_SEC - startSec;
  const step = span > 1200 ? 600 : 300;
  const ticks: number[] = [startSec];
  for (let sec = startSec + step; sec < SPOOF_WATCH_START_SEC; sec += step) {
    if (SPOOF_WATCH_START_SEC - sec >= 120) ticks.push(sec);
  }
  ticks.push(SPOOF_WATCH_START_SEC, PREMARKET_END_SEC);
  return ticks;
}

export function nearestPointAt(points: readonly PreMarketPoint[], targetSec: number): PreMarketPoint | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.secOfDay < targetSec) lo = mid + 1;
    else hi = mid;
  }
  const cand = points[lo]!;
  if (lo === 0) return cand;
  const prev = points[lo - 1]!;
  return Math.abs(prev.secOfDay - targetSec) <= Math.abs(cand.secOfDay - targetSec) ? prev : cand;
}

export function nearestBandAt(
  band: readonly HistoricalBandPoint[],
  targetSec: number,
): HistoricalBandPoint | null {
  if (band.length === 0) return null;
  let lo = 0;
  let hi = band.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (band[mid]!.secOfDay < targetSec) lo = mid + 1;
    else hi = mid;
  }
  const cand = band[lo]!;
  if (lo === 0) return cand;
  const prev = band[lo - 1]!;
  return Math.abs(prev.secOfDay - targetSec) <= Math.abs(cand.secOfDay - targetSec) ? prev : cand;
}

export function computeHistoricalBand(
  pastSeries: readonly PreMarketDaySeries[],
  unit: VolumeUnit,
): readonly HistoricalBandPoint[] {
  const populated = pastSeries.filter((s) => s.points.length > 0);
  if (populated.length === 0) return [];
  const startSec = resolveChartStartSec(populated);
  const sampleCount = Math.floor((PREMARKET_END_SEC - startSec) / BAND_SAMPLE_STEP_SEC) + 1;
  const result: HistoricalBandPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const sec = startSec + i * BAND_SAMPLE_STEP_SEC;
    const pcts: number[] = [];
    const vols: number[] = [];
    let volSum = 0;
    for (const day of populated) {
      const pt = nearestPointAt(day.points, sec);
      if (pt !== null) {
        pcts.push(pt.expectedReturnPct);
        const vol = pointVolumeValue(pt, unit);
        vols.push(vol);
        volSum += vol;
      }
    }
    if (pcts.length === 0) continue;
    pcts.sort((a, b) => a - b);
    vols.sort((a, b) => a - b);
    result.push({
      secOfDay: sec,
      minPct: pcts[0]!,
      p25Pct: quantile(pcts, 0.25),
      medianPct: quantile(pcts, 0.5),
      p75Pct: quantile(pcts, 0.75),
      maxPct: pcts[pcts.length - 1]!,
      minVol: vols[0]!,
      p25Vol: quantile(vols, 0.25),
      medianVol: quantile(vols, 0.5),
      p75Vol: quantile(vols, 0.75),
      maxVol: vols[vols.length - 1]!,
      avgVol: volSum / vols.length,
    });
  }
  return result;
}

export function classifyBreakout(
  value: number,
  bandPoint: HistoricalBandPoint | null,
  minOf: (bandPoint: HistoricalBandPoint) => number,
  maxOf: (bandPoint: HistoricalBandPoint) => number,
): BreakoutState {
  if (bandPoint === null) return "solo";
  if (value > maxOf(bandPoint)) return "above";
  if (value < minOf(bandPoint)) return "below";
  return "inside";
}

export function buildBreakoutSegments(
  points: readonly PreMarketPoint[],
  band: readonly HistoricalBandPoint[],
  valueOf: (pt: PreMarketPoint) => number,
  minOf: (bp: HistoricalBandPoint) => number,
  maxOf: (bp: HistoricalBandPoint) => number,
  xOf: (sec: number) => number,
  yOf: (val: number) => number,
): readonly BreakoutSegment[] {
  if (points.length < 2) return [];
  const hasBand = band.length > 0;
  const out: BreakoutSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const v0 = valueOf(p0);
    const v1 = valueOf(p1);
    const x0 = xOf(p0.secOfDay);
    const x1 = xOf(p1.secOfDay);
    const y0 = yOf(v0);
    const y1 = yOf(v1);
    const key = `${p0.secOfDay}-${p1.secOfDay}`;
    if (!hasBand) {
      out.push({ key, state: "solo", x0, y0, x1, y1, excessPoly: null });
      continue;
    }
    const b0 = nearestBandAt(band, p0.secOfDay);
    const b1 = nearestBandAt(band, p1.secOfDay);
    if (!b0 || !b1) {
      out.push({ key, state: "inside", x0, y0, x1, y1, excessPoly: null });
      continue;
    }
    const mx0 = maxOf(b0);
    const mx1 = maxOf(b1);
    const mn0 = minOf(b0);
    const mn1 = minOf(b1);
    const above = v0 > mx0 || v1 > mx1;
    const below = !above && (v0 < mn0 || v1 < mn1);
    if (above) {
      const top0 = yOf(Math.max(v0, mx0));
      const bot0 = yOf(mx0);
      const top1 = yOf(Math.max(v1, mx1));
      const bot1 = yOf(mx1);
      out.push({
        key,
        state: "above",
        x0,
        y0,
        x1,
        y1,
        excessPoly: `${x0.toFixed(1)},${top0.toFixed(1)} ${x1.toFixed(1)},${top1.toFixed(1)} ${x1.toFixed(1)},${bot1.toFixed(1)} ${x0.toFixed(1)},${bot0.toFixed(1)}`,
      });
    } else if (below) {
      const top0 = yOf(mn0);
      const bot0 = yOf(Math.min(v0, mn0));
      const top1 = yOf(mn1);
      const bot1 = yOf(Math.min(v1, mn1));
      out.push({
        key,
        state: "below",
        x0,
        y0,
        x1,
        y1,
        excessPoly: `${x0.toFixed(1)},${top0.toFixed(1)} ${x1.toFixed(1)},${top1.toFixed(1)} ${x1.toFixed(1)},${bot1.toFixed(1)} ${x0.toFixed(1)},${bot0.toFixed(1)}`,
      });
    } else {
      out.push({ key, state: "inside", x0, y0, x1, y1, excessPoly: null });
    }
  }
  return out;
}

export function buildChartGeometry(
  series: readonly PreMarketDaySeries[],
  focusSeries: PreMarketDaySeries | null,
  historicalBand: readonly HistoricalBandPoint[],
  unit: VolumeUnit,
): ChartGeometry {
  let minPct = 0;
  let maxPct = 0;
  for (const b of historicalBand) {
    if (b.minPct < minPct) minPct = b.minPct;
    if (b.maxPct > maxPct) maxPct = b.maxPct;
  }
  if (focusSeries) {
    for (const pt of focusSeries.points) {
      if (pt.expectedReturnPct < minPct) minPct = pt.expectedReturnPct;
      if (pt.expectedReturnPct > maxPct) maxPct = pt.expectedReturnPct;
    }
  }
  const span = Math.max(2, maxPct - minPct);
  const lo = Math.floor((minPct - span * 0.14) * 2) / 2;
  const hi = Math.ceil((maxPct + span * 0.16) * 2) / 2;

  let peakVol = 0;
  for (const b of historicalBand) {
    if (b.maxVol > peakVol) peakVol = b.maxVol;
  }
  if (focusSeries) {
    for (const pt of focusSeries.points) {
      const v = pointVolumeValue(pt, unit);
      if (v > peakVol) peakVol = v;
    }
  }
  const maxVol = Math.max(1, peakVol * 1.15);

  const plotLeft = CHART_PAD_LEFT;
  const plotRight = CHART_VIEW_W - CHART_PAD_RIGHT;
  const plotTop = CHART_PAD_TOP;
  const plotBottom = CHART_VIEW_H - CHART_PAD_BOTTOM;
  const plotW = plotRight - plotLeft;
  const innerH = Math.max(1, plotBottom - plotTop - CHART_PANEL_GAP);
  const priceH = Math.round(innerH * 0.58);
  const priceBottom = plotTop + priceH;
  const volTop = priceBottom + CHART_PANEL_GAP;
  const volH = Math.max(1, plotBottom - volTop);

  const startSec = resolveChartStartSec(series);
  const xSpan = PREMARKET_END_SEC - startSec;
  const ySpan = Math.max(0.5, hi - lo);

  const xOf = (sec: number) => {
    const ratio = (sec - startSec) / xSpan;
    return plotLeft + Math.max(0, Math.min(1, ratio)) * plotW;
  };
  const yOf = (pct: number) => {
    const ratio = (pct - lo) / ySpan;
    return priceBottom - Math.max(0, Math.min(1, ratio)) * priceH;
  };
  const yVolOf = (vol: number) => {
    const ratio = Math.max(0, Math.min(1, vol / maxVol));
    return plotBottom - ratio * volH;
  };

  const yTicks = Array.from(new Set([hi, 0, lo])).sort((a, b) => b - a);
  const xTicks = buildXTicks(startSec);

  return {
    startSec,
    plotLeft,
    plotRight,
    plotTop,
    priceBottom,
    volTop,
    plotBottom,
    minPct: lo,
    maxPct: hi,
    maxVol,
    xOf,
    yOf,
    yVolOf,
    yTicks,
    xTicks,
  };
}
