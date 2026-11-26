import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import type { PreMarketPoint } from "../../api/generated/PreMarketPoint";
import type { PreMarketSignal } from "../../api/generated/PreMarketSignal";

export const PREMARKET_START_SEC = 8 * 3600 + 30 * 60;
export const PREMARKET_END_SEC = 9 * 3600;
export const SPOOF_WATCH_START_SEC = 8 * 3600 + 58 * 60;
export const MAX_COMPARE_DATES = 10;
export const MAX_PINNED_DATES = 2;
export const BAND_SAMPLE_STEP_SEC = 30;
export const BAND_SAMPLE_COUNT = (PREMARKET_END_SEC - PREMARKET_START_SEC) / BAND_SAMPLE_STEP_SEC + 1;

export const CHART_VIEW_W = 940;
export const CHART_VIEW_H = 380;
export const CHART_PAD_LEFT = 52;
export const CHART_PAD_RIGHT = 66;
export const CHART_PAD_TOP = 20;
export const CHART_PAD_BOTTOM = 28;

export type CompareRange = 5 | 10;
export type VolumeUnit = "qty" | "turnover";
export type BackgroundStyle = "both" | "band" | "lines";

export interface SignalMeta {
  readonly label: string;
  readonly tone: "up" | "warn" | "flat";
}

export interface DateWeekGroup {
  readonly key: string;
  readonly label: string;
  readonly dates: readonly string[];
}

export interface HistoricalBandPoint {
  readonly secOfDay: number;
  readonly p20: number;
  readonly median: number;
  readonly p80: number;
  readonly avgVolume: number;
}

export interface ChartGeometry {
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly minPct: number;
  readonly maxPct: number;
  readonly volTop: number;
  readonly maxVol: number;
  readonly barWidth: number;
  readonly xOf: (sec: number) => number;
  readonly yOf: (pct: number) => number;
  readonly yVolOf: (vol: number) => number;
  readonly secOfX: (x: number) => number;
  readonly yTicks: readonly number[];
  readonly volTicks: readonly number[];
  readonly xTicks: readonly number[];
}

const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function signalMeta(signal: PreMarketSignal): SignalMeta {
  switch (signal) {
    case "genuineGap":
      return { label: "진성 갭", tone: "up" };
    case "spoofWarning":
      return { label: "허수 주의", tone: "warn" };
    case "flat":
      return { label: "보합", tone: "flat" };
  }
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

export function formatShortDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

function parseUtcDate(yyyymmdd: string): Date | null {
  if (yyyymmdd.length !== 8) return null;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatKoreanWeekday(yyyymmdd: string): string {
  const dt = parseUtcDate(yyyymmdd);
  if (!dt) return "";
  return KOREAN_WEEKDAYS[dt.getUTCDay()] ?? "";
}

function mondayEpochDay(yyyymmdd: string): number | null {
  const dt = parseUtcDate(yyyymmdd);
  if (!dt) return null;
  const epochDay = Math.floor(dt.getTime() / 86_400_000);
  const mondayOffset = (dt.getUTCDay() + 6) % 7;
  return epochDay - mondayOffset;
}

function formatEpochDayShort(epochDay: number): string {
  const dt = new Date(epochDay * 86_400_000);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

export function groupDatesByWeek(datesDescending: readonly string[]): readonly DateWeekGroup[] {
  if (datesDescending.length === 0) return [];
  const latestMonday = mondayEpochDay(datesDescending[0]!);
  const groups: { key: string; label: string; dates: string[] }[] = [];
  for (const date of datesDescending) {
    const mon = mondayEpochDay(date);
    const key = mon === null ? "unknown" : String(mon);
    let label = "기간";
    if (mon !== null && latestMonday !== null) {
      const weekDiff = Math.round((latestMonday - mon) / 7);
      if (weekDiff === 0) label = "이번주";
      else if (weekDiff === 1) label = "지난주";
      else label = `${formatEpochDayShort(mon)}주`;
    }
    const existing = groups[groups.length - 1];
    if (existing && existing.key === key) existing.dates.push(date);
    else groups.push({ key, label, dates: [date] });
  }
  return groups;
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

export function formatQty(qty: number): string {
  if (!Number.isFinite(qty) || qty < 0) return "—";
  if (qty === 0) return "0주";
  if (qty >= 10_000) return `${(qty / 10_000).toFixed(1)}만주`;
  return `${Math.round(qty).toLocaleString("ko-KR")}주`;
}

export function formatSignedQty(delta: number): string {
  if (!Number.isFinite(delta)) return "—";
  if (delta === 0) return "0주";
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${formatQty(Math.abs(delta))}`;
}

export function formatTurnover(millionWon: number): string {
  if (!Number.isFinite(millionWon) || millionWon <= 0) return "—";
  if (millionWon >= 100) return `${(millionWon / 100).toFixed(1)}억`;
  return `${Math.round(millionWon).toLocaleString("ko-KR")}백만`;
}

export function formatSignedTurnover(deltaMillionWon: number): string {
  if (!Number.isFinite(deltaMillionWon)) return "—";
  if (deltaMillionWon === 0) return "0억";
  const sign = deltaMillionWon > 0 ? "+" : "-";
  const abs = Math.abs(deltaMillionWon);
  if (abs >= 100) return `${sign}${(abs / 100).toFixed(1)}억`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}백만`;
}

export function pointVolumeValue(point: PreMarketPoint, unit: VolumeUnit): number {
  return unit === "qty" ? point.expectedQty : point.expectedTurnoverMillionWon;
}

export function formatVolumeValue(value: number, unit: VolumeUnit): string {
  if (unit === "qty") return formatQty(value);
  if (value <= 0) return "0억";
  return formatTurnover(value);
}

export function formatVolumeDelta(delta: number, unit: VolumeUnit): string {
  return unit === "qty" ? formatSignedQty(delta) : formatSignedTurnover(delta);
}

export function selectRangeDates(available: readonly string[], range: CompareRange): string[] {
  const limit = Math.min(range, MAX_COMPARE_DATES);
  if (available.length <= limit) return [...available];
  return available.slice(available.length - limit);
}

export function togglePinnedDate(
  current: readonly string[],
  date: string,
  focusDate: string | null,
): string[] {
  if (date === focusDate) return [...current];
  if (current.includes(date)) return current.filter((d) => d !== date);
  const kept = current.filter((d) => d !== focusDate);
  if (kept.length >= MAX_PINNED_DATES) return [...kept.slice(kept.length - MAX_PINNED_DATES + 1), date];
  return [...kept, date];
}

export function computePointDeltas(points: readonly PreMarketPoint[], unit: VolumeUnit): readonly number[] {
  const deltas: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      deltas.push(0);
    } else {
      const curr = pointVolumeValue(points[i]!, unit);
      const prev = pointVolumeValue(points[i - 1]!, unit);
      deltas.push(curr - prev);
    }
  }
  return deltas;
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

export function computeHistoricalBand(
  pastSeries: readonly PreMarketDaySeries[],
  unit: VolumeUnit,
): readonly HistoricalBandPoint[] {
  const populated = pastSeries.filter((s) => s.points.length > 0);
  if (populated.length === 0) return [];
  const result: HistoricalBandPoint[] = [];
  for (let i = 0; i < BAND_SAMPLE_COUNT; i++) {
    const sec = PREMARKET_START_SEC + i * BAND_SAMPLE_STEP_SEC;
    const pcts: number[] = [];
    let volSum = 0;
    for (const day of populated) {
      const pt = nearestPointAt(day.points, sec);
      if (pt !== null) {
        pcts.push(pt.expectedReturnPct);
        volSum += pointVolumeValue(pt, unit);
      }
    }
    if (pcts.length === 0) continue;
    pcts.sort((a, b) => a - b);
    result.push({
      secOfDay: sec,
      p20: quantile(pcts, 0.2),
      median: quantile(pcts, 0.5),
      p80: quantile(pcts, 0.8),
      avgVolume: volSum / pcts.length,
    });
  }
  return result;
}

export function buildChartGeometry(
  series: readonly PreMarketDaySeries[],
  focusSeries: PreMarketDaySeries | null = null,
  historicalBand: readonly HistoricalBandPoint[] = [],
  spotSeries: PreMarketDaySeries | null = null,
  unit: VolumeUnit = "qty",
): ChartGeometry {
  let minPct = 0;
  let maxPct = 0;
  for (const s of series) {
    for (const pt of s.points) {
      if (pt.expectedReturnPct < minPct) minPct = pt.expectedReturnPct;
      if (pt.expectedReturnPct > maxPct) maxPct = pt.expectedReturnPct;
    }
  }
  const span = Math.max(2, maxPct - minPct);
  const pad = span * 0.15;
  const lo = Math.floor((minPct - pad) * 2) / 2;
  const hi = Math.ceil((maxPct + pad) * 2) / 2;

  let peakVol = 0;
  if (focusSeries) {
    for (const pt of focusSeries.points) {
      const v = pointVolumeValue(pt, unit);
      if (v > peakVol) peakVol = v;
    }
  }
  for (const b of historicalBand) {
    if (b.avgVolume > peakVol) peakVol = b.avgVolume;
  }
  if (spotSeries) {
    for (const pt of spotSeries.points) {
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
  const plotH = plotBottom - plotTop;
  const volTop = plotTop + plotH * 0.56;
  const volH = plotBottom - volTop;
  const xSpan = PREMARKET_END_SEC - PREMARKET_START_SEC;
  const ySpan = Math.max(0.5, hi - lo);

  const xOf = (sec: number) => {
    const ratio = (sec - PREMARKET_START_SEC) / xSpan;
    return plotLeft + Math.max(0, Math.min(1, ratio)) * plotW;
  };
  const yOf = (pct: number) => {
    const ratio = (pct - lo) / ySpan;
    return plotBottom - Math.max(0, Math.min(1, ratio)) * plotH;
  };
  const yVolOf = (vol: number) => {
    const ratio = Math.max(0, Math.min(1, vol / maxVol));
    return plotBottom - ratio * volH;
  };
  const secOfX = (x: number) => {
    const ratio = Math.max(0, Math.min(1, (x - plotLeft) / plotW));
    return Math.round(PREMARKET_START_SEC + ratio * xSpan);
  };

  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) {
    yTicks.push(Math.round((hi - ((hi - lo) * i) / 4) * 10) / 10);
  }
  const volTicks = [0, maxVol * 0.5, maxVol];
  const xTicks = [
    PREMARKET_START_SEC,
    8 * 3600 + 40 * 60,
    8 * 3600 + 50 * 60,
    SPOOF_WATCH_START_SEC,
    PREMARKET_END_SEC,
  ];
  const pointCount = Math.max(12, focusSeries?.points.length ?? 60);
  const barWidth = Math.max(3, Math.min(14, (plotW / pointCount) * 0.68));

  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    minPct: lo,
    maxPct: hi,
    volTop,
    maxVol,
    barWidth,
    xOf,
    yOf,
    yVolOf,
    secOfX,
    yTicks,
    volTicks,
    xTicks,
  };
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
