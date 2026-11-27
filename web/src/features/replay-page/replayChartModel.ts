import type { ReplayEngineFrame } from "./replayEngine";
import type { ReplayMinutePoint } from "./replayModel";

export const REPLAY_CHART_TIMEFRAMES = [1, 3, 5, 10, 15, 30] as const;
export type ReplayChartTimeframe = (typeof REPLAY_CHART_TIMEFRAMES)[number];

export interface AggregatedReplayBar {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly sec: number;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly volume: number;
  readonly vwap: number | null;
  readonly totalAsk: number | null;
  readonly totalBid: number | null;
  readonly obi: number | null;
  readonly strength: number | null;
  readonly programNetQty: number | null;
  readonly programNetAmtMillion: number | null;
  readonly inGap: boolean;
  readonly singlePrice: boolean;
  readonly isCurrent: boolean;
  readonly isFuture: boolean;
}

export interface ChartViewport {
  readonly start: number;
  readonly end: number;
}

const MIN_VISIBLE_BARS = 8;

function resolveMinutePoint(
  bar: ReplayMinutePoint,
  frame: ReplayEngineFrame,
  isCurrentMinute: boolean,
): ReplayMinutePoint {
  if (!isCurrentMinute || frame.resolution !== "tick") return bar;
  if (frame.formingBar && frame.formingBar.minute === bar.minute) {
    return {
      ...bar,
      open: frame.formingBar.open,
      high: frame.formingBar.high,
      low: frame.formingBar.low,
      close: frame.formingBar.close,
      volume: frame.formingBar.volume,
      vwap: frame.vwap ?? bar.vwap,
    };
  }
  if (frame.price !== null) {
    return {
      ...bar,
      open: frame.price,
      high: frame.price,
      low: frame.price,
      close: frame.price,
      volume: 0,
      vwap: frame.vwap ?? bar.vwap,
    };
  }
  return { ...bar, open: null, high: null, low: null, close: null, volume: 0 };
}

export function aggregateReplayBars(
  minutes: readonly ReplayMinutePoint[],
  timeframe: ReplayChartTimeframe,
  frame: ReplayEngineFrame,
  curMinute: number,
): AggregatedReplayBar[] {
  if (minutes.length === 0) return [];
  const baseMinute = minutes[0]!.minute;
  const buckets = new Map<number, ReplayMinutePoint[]>();

  for (const pt of minutes) {
    const bucketOffset = Math.floor((pt.minute - baseMinute) / timeframe);
    const startMinute = baseMinute + bucketOffset * timeframe;
    const list = buckets.get(startMinute);
    if (list) list.push(pt);
    else buckets.set(startMinute, [pt]);
  }

  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);
  const result: AggregatedReplayBar[] = [];

  for (const startMinute of sortedStarts) {
    const endMinute = startMinute + timeframe - 1;
    const rawList = buckets.get(startMinute)!;
    const isFuture = startMinute > curMinute;
    const isCurrent = curMinute >= startMinute && curMinute <= endMinute;

    let open: number | null = null;
    let high: number | null = null;
    let low: number | null = null;
    let close: number | null = null;
    let volume = 0;
    let vwap: number | null = null;
    let totalAsk: number | null = null;
    let totalBid: number | null = null;
    let obi: number | null = null;
    let strength: number | null = null;
    let programNetQty: number | null = null;
    let programNetAmtMillion: number | null = null;
    let allGap = true;
    let anySinglePrice = false;

    for (const raw of rawList) {
      if (isCurrent && raw.minute > curMinute) continue;
      const pt = resolveMinutePoint(raw, frame, raw.minute === curMinute);
      if (!pt.inGap) allGap = false;
      if (pt.singlePrice) anySinglePrice = true;
      if (open === null && pt.open !== null) open = pt.open;
      if (pt.high !== null && (high === null || pt.high > high)) high = pt.high;
      if (pt.low !== null && (low === null || pt.low < low)) low = pt.low;
      if (pt.close !== null) close = pt.close;
      volume += pt.volume;
      if (pt.vwap !== null) vwap = pt.vwap;
      if (pt.totalAsk !== null) totalAsk = pt.totalAsk;
      if (pt.totalBid !== null) totalBid = pt.totalBid;
      if (pt.obi !== null) obi = pt.obi;
      if (pt.strength !== null) strength = pt.strength;
      if (pt.programNetQty !== null) programNetQty = pt.programNetQty;
      if (pt.programNetAmtMillion !== null) programNetAmtMillion = pt.programNetAmtMillion;
    }

    result.push({
      startMinute,
      endMinute,
      sec: startMinute * 60,
      open,
      high,
      low,
      close,
      volume,
      vwap,
      totalAsk,
      totalBid,
      obi,
      strength,
      programNetQty,
      programNetAmtMillion,
      inGap: allGap,
      singlePrice: anySinglePrice,
      isCurrent,
      isFuture,
    });
  }

  return result;
}

export function clampViewport(view: ChartViewport, totalBars: number): ChartViewport {
  if (totalBars <= 0) return { start: 0, end: 0 };
  const minSpan = Math.min(MIN_VISIBLE_BARS, totalBars);
  const span = Math.max(minSpan, Math.min(totalBars, view.end - view.start));
  const start = Math.max(0, Math.min(totalBars - span, view.start));
  return { start, end: start + span };
}

export function zoomViewport(
  view: ChartViewport,
  totalBars: number,
  anchorRatio: number,
  factor: number,
): ChartViewport {
  if (totalBars <= 0) return { start: 0, end: 0 };
  const clamped = clampViewport(view, totalBars);
  const clampedRatio = Math.max(0, Math.min(1, anchorRatio));
  const oldSpan = clamped.end - clamped.start;
  const minSpan = Math.min(MIN_VISIBLE_BARS, totalBars);
  const nextSpan = Math.max(minSpan, Math.min(totalBars, oldSpan * factor));
  const anchorBar = clamped.start + clampedRatio * oldSpan;
  const nextStart = anchorBar - clampedRatio * nextSpan;
  return clampViewport({ start: nextStart, end: nextStart + nextSpan }, totalBars);
}

export function panViewport(
  view: ChartViewport,
  totalBars: number,
  deltaBars: number,
): ChartViewport {
  if (totalBars <= 0) return { start: 0, end: 0 };
  const clamped = clampViewport(view, totalBars);
  const span = clamped.end - clamped.start;
  const nextStart = Math.max(0, Math.min(totalBars - span, clamped.start + deltaBars));
  return { start: nextStart, end: nextStart + span };
}
