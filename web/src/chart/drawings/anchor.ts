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

const MINUTES: Record<Exclude<Period, "D" | "W" | "M" | "Q" | "Y">, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
};

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
  if (tl.period !== "D" && tl.period !== "W" && tl.period !== "M" && tl.period !== "Q" && tl.period !== "Y") return last + n * MINUTES[tl.period] * 60;
  let future = futureCache.get(tl);
  if (future === undefined) {
    future = [];
    futureCache.set(tl, future);
  }
  while (future.length < n) future.push(nextBarStart(tl.period, future.at(-1) ?? last));
  return future[n - 1] ?? null;
}

export function startAt(tl: Timeline, k: number): UnixSeconds | null {
  if (!Number.isInteger(k) || k < 0) return null;
  const real = tl.starts[k];
  if (real !== undefined) return real;
  return futureStart(tl, k - (tl.starts.length - 1));
}

function barIndexAtOrBefore(tl: Timeline, t: UnixSeconds): number | null {
  const { starts } = tl;
  const first = starts[0];
  const last = starts.at(-1);
  if (first === undefined || last === undefined || t < first) return null;
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
  if (!Number.isFinite(logical) || logical < 0) return null;
  const k = Math.floor(logical);
  const start = startAt(tl, k);
  if (start === null) return null;
  return Math.round(start + (logical - k) * barLength(tl.period, start));
}

export function shiftBars(tl: Timeline, t: UnixSeconds, n: number): UnixSeconds | null {
  const logical = tToLogical(tl, t);
  return logical === null ? null : startAt(tl, Math.floor(logical) + n);
}

export interface TimeAxis {
  coordinateOf(index: number): number | null;
  indexAt(x: number): number | null;
  readonly barSpacing: number;
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

export function timeToX(p: Projection, t: UnixSeconds): number | null {
  const logical = tToLogical(p.timeline, t);
  return logical === null ? null : logicalToX(p.axes.time, logical);
}

export function xToTime(p: Projection, x: number): UnixSeconds | null {
  const logical = xToLogical(p.axes.time, x);
  return logical === null ? null : logicalToT(p.timeline, logical);
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

export function barsBetween(f: Frame, t1: UnixSeconds, t2: UnixSeconds): { count: number; volume: number } | null {
  const a = tToLogical(f.timeline, t1);
  const b = tToLogical(f.timeline, t2);
  if (a === null || b === null) return null;
  const lo = Math.floor(Math.min(a, b));
  const hi = Math.floor(Math.max(a, b));
  let volume = 0;
  for (const bar of f.bars.slice(lo, hi + 1)) volume += bar.v;
  return { count: hi - lo, volume };
}

export function toolContext(f: Frame, format: { price(p: number): string; time(t: UnixSeconds): string }): ToolContext {
  return {
    toScreen: (p) => toScreen(f, p),
    fromScreen: (s) => fromScreen(f, s),
    xOf: (t) => timeToX(f, t),
    yOf: (price) => f.axes.price.toY(price),
    timeAt: (x) => xToTime(f, x),
    priceAt: (y) => f.axes.price.toPrice(y),
    shiftBars: (t, n) => shiftBars(f.timeline, t, n),
    barsBetween: (t1, t2) => barsBetween(f, t1, t2),
    paneWidth: f.pane.width,
    paneHeight: f.pane.height,
    formatPrice: format.price,
    formatTime: format.time,
    logScale: f.logScale,
  };
}
