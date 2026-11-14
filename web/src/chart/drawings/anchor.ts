import type { Bar } from "../../api/generated/Bar";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { toChartTime } from "../time";
import type { ToolContext } from "./toolSpec";
import type { DrawingPoint, ScreenPoint } from "./types";

export interface Timeline {
  readonly period: Period;
  readonly starts: readonly UnixSeconds[];
}

export function timelineOf(bars: readonly Bar[], period: Period): Timeline {
  return { period, starts: bars.map((b) => b.t) };
}

const DAY = 86_400;
export const MAX_FUTURE_BARS = 5_000;

type CalendarPeriod = "D" | "W" | "M" | "Q" | "Y";

const MINUTES: Record<Exclude<Period, CalendarPeriod>, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "10m": 10,
  "15m": 15,
  "30m": 30,
  "60m": 60,
};

const isCalendar = (period: Period): period is CalendarPeriod => period === "D" || period === "W" || period === "M" || period === "Q" || period === "Y";

const TYPICAL_LENGTH: Record<CalendarPeriod, number> = { D: (7 / 5) * DAY, W: 7 * DAY, M: 30.44 * DAY, Q: 91.31 * DAY, Y: 365.25 * DAY };
const MONTHS_PER_BAR = { M: 1, Q: 3, Y: 12 } as const;

function kstCalendar(t: UnixSeconds) {
  const wall = toChartTime(t);
  const d = new Date(wall * 1000);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    midnight: t - (wall % DAY),
    weekday: d.getUTCDay(),
    dayOfMonth: d.getUTCDate(),
    daysInMonth,
  };
}

function calendarBounds(period: "Q" | "Y", t: UnixSeconds) {
  const wall = toChartTime(t);
  const d = new Date(wall * 1000);
  const months = period === "Q" ? 3 : 12;
  const month = Math.floor(d.getUTCMonth() / months) * months;
  const offset = wall - t;
  const start = Date.UTC(d.getUTCFullYear(), month, 1) / 1000 - offset;
  const next = Date.UTC(d.getUTCFullYear(), month + months, 1) / 1000 - offset;
  return { start, next };
}

export function barLength(period: Period, start: UnixSeconds): number {
  switch (period) {
    case "D":
      return DAY;
    case "W":
      return 7 * DAY;
    case "M":
      return kstCalendar(start).daysInMonth * DAY;
    case "Q":
    case "Y": {
      const { start: first, next } = calendarBounds(period, start);
      return next - first;
    }
    default:
      return MINUTES[period] * 60;
  }
}

export function nextBarStart(period: Period, start: UnixSeconds): UnixSeconds {
  switch (period) {
    case "D": {
      let next = kstCalendar(start).midnight + DAY;
      for (let wd = kstCalendar(next).weekday; wd === 0 || wd === 6; wd = kstCalendar(next).weekday) next += DAY;
      return next;
    }
    case "W": {
      const c = kstCalendar(start);
      const daysSinceMonday = (c.weekday + 6) % 7;
      return c.midnight + (7 - daysSinceMonday) * DAY;
    }
    case "M": {
      const c = kstCalendar(start);
      return c.midnight + (c.daysInMonth - c.dayOfMonth + 1) * DAY;
    }
    case "Q":
    case "Y":
      return calendarBounds(period, start).next;
    default:
      return start + MINUTES[period] * 60;
  }
}

const futureCache = new WeakMap<Timeline, UnixSeconds[]>();

function futureStart(tl: Timeline, n: number): UnixSeconds | null {
  const last = tl.starts.at(-1);
  if (last === undefined || n > MAX_FUTURE_BARS) return null;
  if (!isCalendar(tl.period)) return last + n * MINUTES[tl.period] * 60;
  let future = futureCache.get(tl);
  if (future === undefined) {
    future = [];
    futureCache.set(tl, future);
  }
  while (future.length < n) future.push(nextBarStart(tl.period, future.at(-1) ?? last));
  return future[n - 1] ?? null;
}

function startBefore(period: Period, first: UnixSeconds, n: number): UnixSeconds {
  switch (period) {
    case "D": {
      let t = kstCalendar(first).midnight - Math.floor(n / 5) * 7 * DAY;
      for (let left = n % 5; left > 0; ) {
        t -= DAY;
        const weekday = kstCalendar(t).weekday;
        if (weekday !== 0 && weekday !== 6) left--;
      }
      return t;
    }
    case "W": {
      const c = kstCalendar(first);
      return c.midnight - ((c.weekday + 6) % 7) * DAY - n * 7 * DAY;
    }
    case "M":
    case "Q":
    case "Y": {
      const wall = toChartTime(first);
      const d = new Date(wall * 1000);
      const months = MONTHS_PER_BAR[period];
      const month = Math.floor(d.getUTCMonth() / months) * months;
      return Date.UTC(d.getUTCFullYear(), month - n * months, 1) / 1000 - (wall - first);
    }
    default:
      return first - n * MINUTES[period] * 60;
  }
}

function pastIndex(period: Period, first: UnixSeconds, t: UnixSeconds): number | null {
  const typical = isCalendar(period) ? TYPICAL_LENGTH[period] : MINUTES[period] * 60;
  let n = Math.max(1, Math.ceil((first - t) / typical));
  if (!Number.isSafeInteger(n) || !Number.isFinite(startBefore(period, first, n))) return null;
  while (startBefore(period, first, n) > t) n++;
  while (n > 1 && startBefore(period, first, n - 1) <= t) n--;
  return -n;
}

export function startAt(tl: Timeline, k: number): UnixSeconds | null {
  if (!Number.isInteger(k)) return null;
  const first = tl.starts[0];
  if (k < 0) return first === undefined ? null : startBefore(tl.period, first, -k);
  const real = tl.starts[k];
  if (real !== undefined) return real;
  return futureStart(tl, k - (tl.starts.length - 1));
}

function barIndexAtOrBefore(tl: Timeline, t: UnixSeconds): number | null {
  const { starts } = tl;
  const first = starts[0];
  const last = starts.at(-1);
  if (first === undefined || last === undefined) return null;
  if (t < first) return pastIndex(tl.period, first, t);
  if (t >= last) {
    let k = starts.length - 1;
    for (let next = startAt(tl, k + 1); next !== null && next <= t; next = startAt(tl, k + 1)) k++;
    return k;
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const s = starts[mid];
    if (s !== undefined && s <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function tToLogical(tl: Timeline, t: UnixSeconds): number | null {
  const k = barIndexAtOrBefore(tl, t);
  if (k === null) return null;
  const start = startAt(tl, k);
  if (start === null) return null;
  const length = barLength(tl.period, start);
  return t < start + length ? k + (t - start) / length : k + 1;
}

export function logicalToT(tl: Timeline, logical: number): UnixSeconds | null {
  if (!Number.isFinite(logical)) return null;
  const k = Math.floor(logical);
  const start = startAt(tl, k);
  if (start === null) return null;
  return Math.round(start + (logical - k) * barLength(tl.period, start));
}

export interface TimeProjection {
  toLogical(t: UnixSeconds): number | null;
  toTime(logical: number): UnixSeconds | null;
}

export interface TimeAxis {
  coordinateOf(index: number): number | null;
  indexAt(x: number): number | null;
  readonly barSpacing: number;
  readonly projection?: TimeProjection;
}

export interface PriceAxis {
  toY(price: number): number | null;
  toPrice(y: number): number | null;
}

export interface Axes {
  readonly time: TimeAxis;
  readonly price: PriceAxis;
}

// Lightweight Charts returns 0 from logicalToCoordinate for a fractional index, so only integers reach the axis.
export function logicalToX(axis: TimeAxis, logical: number): number | null {
  const k = Math.floor(logical);
  const base = axis.coordinateOf(k);
  return base === null ? null : base + (logical - k) * axis.barSpacing;
}

export function xToLogical(axis: TimeAxis, x: number): number | null {
  const k = axis.indexAt(x);
  if (k === null) return null;
  const base = axis.coordinateOf(k);
  return base === null ? null : k + (x - base) / axis.barSpacing;
}

export interface Projection {
  readonly timeline: Timeline;
  readonly axes: Axes;
}

function slotsOf(p: Projection): TimeProjection {
  return p.axes.time.projection ?? { toLogical: (t) => tToLogical(p.timeline, t), toTime: (logical) => logicalToT(p.timeline, logical) };
}

export function timeToX(p: Projection, t: UnixSeconds): number | null {
  const logical = slotsOf(p).toLogical(t);
  return logical === null ? null : logicalToX(p.axes.time, logical);
}

export function xToTime(p: Projection, x: number): UnixSeconds | null {
  const logical = xToLogical(p.axes.time, x);
  return logical === null ? null : slotsOf(p).toTime(logical);
}

function slotUnder(p: Projection, t: UnixSeconds): number | null {
  const logical = slotsOf(p).toLogical(t);
  return logical === null ? null : Math.floor(logical + 0.5);
}

export function shiftBars(p: Projection, t: UnixSeconds, n: number): UnixSeconds | null {
  const slot = slotUnder(p, t);
  return slot === null ? null : slotsOf(p).toTime(slot + n);
}

export function toScreen(p: Projection, point: DrawingPoint): ScreenPoint | null {
  const x = timeToX(p, point.t);
  const y = p.axes.price.toY(point.price);
  return x === null || y === null ? null : { x, y };
}

export function fromScreen(p: Projection, s: ScreenPoint): DrawingPoint | null {
  const t = xToTime(p, s.x);
  const price = p.axes.price.toPrice(s.y);
  return t === null || price === null ? null : { t, price };
}

export interface Frame extends Projection {
  readonly bars: readonly Bar[];
  readonly pane: { readonly width: number; readonly height: number };
  readonly logScale: boolean;
}

function firstAtOrAfter(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((bars[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const loadedBetween = (bars: readonly Bar[], from: UnixSeconds, to: UnixSeconds) => bars.slice(firstAtOrAfter(bars, from), firstAtOrAfter(bars, to + 1));

function slotRange(f: Frame, t1: UnixSeconds, t2: UnixSeconds): { lo: number; hi: number; from: number; to: number } | null {
  const a = slotUnder(f, t1);
  const b = slotUnder(f, t2);
  if (a === null || b === null) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { lo, hi, from: slotsOf(f).toTime(lo) ?? Infinity, to: slotsOf(f).toTime(hi) ?? Infinity };
}

export function barsBetween(f: Frame, t1: UnixSeconds, t2: UnixSeconds): { count: number; volume: number } | null {
  const range = slotRange(f, t1, t2);
  if (range === null) return null;
  let volume = 0;
  for (const bar of loadedBetween(f.bars, range.from, range.to)) volume += bar.v;
  return { count: range.hi - range.lo, volume };
}

export function barsIn(f: Frame, t1: UnixSeconds, t2?: UnixSeconds): readonly Bar[] {
  const last = f.bars.at(-1);
  if (last === undefined) return [];
  const range = slotRange(f, t1, t2 ?? t1);
  if (range === null) return [];
  return loadedBetween(f.bars, Math.min(range.from, last.t), t2 === undefined ? last.t : range.to);
}

export function toolContext(f: Frame, format: { price(p: number): string; time(t: UnixSeconds): string }): ToolContext {
  return {
    toScreen: (p) => toScreen(f, p),
    fromScreen: (s) => fromScreen(f, s),
    xOf: (t) => timeToX(f, t),
    yOf: (price) => f.axes.price.toY(price),
    timeAt: (x) => xToTime(f, x),
    priceAt: (y) => f.axes.price.toPrice(y),
    shiftBars: (t, n) => shiftBars(f, t, n),
    barsBetween: (t1, t2) => barsBetween(f, t1, t2),
    barsIn: (t1, t2) => barsIn(f, t1, t2),
    paneWidth: f.pane.width,
    paneHeight: f.pane.height,
    formatPrice: format.price,
    formatTime: format.time,
    logScale: f.logScale,
  };
}
