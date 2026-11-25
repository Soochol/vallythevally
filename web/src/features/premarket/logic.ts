import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import type { PreMarketPoint } from "../../api/generated/PreMarketPoint";
import type { PreMarketSignal } from "../../api/generated/PreMarketSignal";
import type { PreMarketSnapshotRow } from "../../api/generated/PreMarketSnapshotRow";

export const PREMARKET_START_SEC = 8 * 3600 + 30 * 60;
export const PREMARKET_END_SEC = 9 * 3600;
export const SPOOF_WATCH_START_SEC = 8 * 3600 + 58 * 60;
export const WIDE_BREAKPOINT_PX = 680;
export const MAX_COMPARE_DATES = 4;

export const CHART_VIEW_W = 600;
export const CHART_VIEW_H = 220;
export const CHART_PAD_LEFT = 46;
export const CHART_PAD_RIGHT = 14;
export const CHART_PAD_TOP = 16;
export const CHART_PAD_BOTTOM = 26;

export type SnapshotFilter = "all" | "genuineGap" | "spoofWarning" | "extended";

export interface SignalMeta {
  readonly label: string;
  readonly tone: "up" | "warn" | "flat";
}

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

export function formatFullDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}.${yyyymmdd.slice(4, 6)}.${yyyymmdd.slice(6, 8)}`;
}

export function formatSignedPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ko-KR");
}

export function formatTurnover(millionWon: number): string {
  if (!Number.isFinite(millionWon) || millionWon <= 0) return "—";
  if (millionWon >= 100) return `${(millionWon / 100).toFixed(1)}억`;
  return `${Math.round(millionWon).toLocaleString("ko-KR")}백만`;
}

export function toggleDateSelection(current: readonly string[], date: string): string[] {
  if (current.includes(date)) {
    if (current.length <= 1) return [...current];
    return current.filter((d) => d !== date);
  }
  if (current.length >= MAX_COMPARE_DATES) return [...current];
  return [...current, date].sort();
}

export function defaultSelectedDates(available: readonly string[]): string[] {
  if (available.length <= 3) return [...available];
  return available.slice(available.length - 3);
}

export function filterSnapshotRows(rows: readonly PreMarketSnapshotRow[], filter: SnapshotFilter): readonly PreMarketSnapshotRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "genuineGap":
      return rows.filter((row) => row.signal === "genuineGap");
    case "spoofWarning":
      return rows.filter((row) => row.signal === "spoofWarning");
    case "extended":
      return rows.filter((row) => row.preMarketExtended);
  }
}

export interface ChartGeometry {
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly minPct: number;
  readonly maxPct: number;
  readonly xOf: (sec: number) => number;
  readonly yOf: (pct: number) => number;
  readonly secOfX: (x: number) => number;
  readonly yTicks: readonly number[];
  readonly xTicks: readonly number[];
}

export function buildChartGeometry(series: readonly PreMarketDaySeries[]): ChartGeometry {
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
  const plotLeft = CHART_PAD_LEFT;
  const plotRight = CHART_VIEW_W - CHART_PAD_RIGHT;
  const plotTop = CHART_PAD_TOP;
  const plotBottom = CHART_VIEW_H - CHART_PAD_BOTTOM;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;
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
  const secOfX = (x: number) => {
    const ratio = Math.max(0, Math.min(1, (x - plotLeft) / plotW));
    return Math.round(PREMARKET_START_SEC + ratio * xSpan);
  };
  const mid = Math.round(((lo + hi) / 2) * 10) / 10;
  const yTicks = [hi, mid, lo];
  const xTicks = [
    PREMARKET_START_SEC,
    8 * 3600 + 40 * 60,
    8 * 3600 + 50 * 60,
    SPOOF_WATCH_START_SEC,
    PREMARKET_END_SEC,
  ];
  return { plotLeft, plotRight, plotTop, plotBottom, minPct: lo, maxPct: hi, xOf, yOf, secOfX, yTicks, xTicks };
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
