import type { Bar } from "../../api/generated/Bar";
import { PERIOD_ORDER } from "../../chart/crosshairSync";
import { isRegularHours, toChartTime } from "../../chart/time";
import type { MinutePeriod } from "../../lib/symbol";
import type { ReplayEngineFrame } from "../replay-page/replayEngine";
import type { ReplayFrame, ReplayMinutePoint, ReplaySession } from "../replay-page/replayModel";

export interface ProjectTickReplayBarsInput {
  readonly session: ReplaySession;
  readonly frame: ReplayEngineFrame;
  readonly period: MinutePeriod;
  readonly priorBars: readonly Bar[];
  readonly priorPeriod?: MinutePeriod | null;
  readonly regularHoursOnly: boolean;
  readonly isArchive: boolean;
}

export interface ProjectedTickReplayBars {
  readonly bars: Bar[];
  readonly current: Bar | null;
}

interface OhlcvPart {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

function minuteOnlyCurrentPart(
  frames: readonly ReplayFrame[],
  pt: ReplayMinutePoint,
  curMin: number,
  curSec: number,
): OhlcvPart | null {
  let open: number | null = null;
  let high = -Infinity;
  let low = Infinity;
  let close: number | null = null;
  let volume = 0;

  for (const entry of frames) {
    if (entry.minute < curMin) continue;
    if (entry.minute > curMin || entry.t > curSec) break;
    if (entry.inGap) continue;
    if (entry.trade !== null) {
      const px = entry.trade.price;
      if (open === null) open = px;
      if (px > high) high = px;
      if (px < low) low = px;
      close = px;
      volume += entry.trade.quantity;
    }
  }

  if (open !== null && close !== null) {
    return { open, high, low, close, volume };
  }
  if (
    curSec >= pt.sec + 59
    && pt.open !== null
    && pt.high !== null
    && pt.low !== null
    && pt.close !== null
  ) {
    return { open: pt.open, high: pt.high, low: pt.low, close: pt.close, volume: pt.volume };
  }
  return null;
}

function resolveMinuteOhlcv(
  pt: ReplayMinutePoint,
  session: ReplaySession,
  frame: ReplayEngineFrame,
  curMin: number,
  curSec: number,
): OhlcvPart | null {
  if (pt.minute > curMin) return null;
  if (pt.inGap && pt.volume === 0) return null;
  if (pt.minute === curMin) {
    if (frame.resolution === "tick") {
      const forming = frame.formingBar;
      if (forming && forming.minute === curMin) {
        return {
          open: forming.open,
          high: forming.high,
          low: forming.low,
          close: forming.close,
          volume: forming.volume,
        };
      }
      return null;
    }
    return minuteOnlyCurrentPart(session.frames, pt, curMin, curSec);
  }
  if (pt.open === null || pt.high === null || pt.low === null || pt.close === null) return null;
  return { open: pt.open, high: pt.high, low: pt.low, close: pt.close, volume: pt.volume };
}

const DAY_SECONDS = 86_400;

function aggregatePriorBars(
  priorBars: readonly Bar[],
  priorPeriod: MinutePeriod | null | undefined,
  period: MinutePeriod,
  dayStartUnix: number,
  regularHoursOnly: boolean,
): Bar[] {
  const sourceMins = priorPeriod !== null && priorPeriod !== undefined ? PERIOD_ORDER[priorPeriod] : PERIOD_ORDER[period];
  const targetMins = PERIOD_ORDER[period];
  if (targetMins < sourceMins || targetMins % sourceMins !== 0) return [];

  const targetSec = targetMins * 60;
  const out: Bar[] = [];
  for (const bar of priorBars) {
    if (bar.t >= dayStartUnix) continue;
    if (regularHoursOnly && !isRegularHours(bar.t)) continue;
    if (targetMins === sourceMins) {
      const last = out[out.length - 1];
      if (last && last.t >= bar.t) continue;
      out.push(bar);
      continue;
    }
    const wall = toChartTime(bar.t);
    const dayOffset = ((wall % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
    const bucketT = bar.t - dayOffset + Math.floor(dayOffset / targetSec) * targetSec;
    if (regularHoursOnly && !isRegularHours(bucketT)) continue;
    const last = out[out.length - 1];
    if (last && last.t === bucketT) {
      out[out.length - 1] = {
        t: last.t,
        o: last.o,
        h: Math.max(last.h, bar.h),
        l: Math.min(last.l, bar.l),
        c: bar.c,
        v: last.v + bar.v,
      };
    } else if (!last || bucketT > last.t) {
      out.push({ t: bucketT, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    }
  }
  return out;
}

export function projectTickReplayBars(input: ProjectTickReplayBarsInput): ProjectedTickReplayBars {
  const { session, frame, period, priorBars, priorPeriod, regularHoursOnly, isArchive } = input;
  const periodMins = PERIOD_ORDER[period];
  const curMin = Math.floor(frame.cursorMs / 60_000);
  const curSec = Math.floor(frame.cursorMs / 1_000);
  const curBucketStart = Math.floor(curMin / periodMins) * periodMins;

  const bars: Bar[] = isArchive
    ? []
    : aggregatePriorBars(priorBars, priorPeriod, period, session.dayStartUnix, regularHoursOnly);

  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const pt of session.minutes) {
    if (pt.minute > curMin) break;
    const part = resolveMinuteOhlcv(pt, session, frame, curMin, curSec);
    if (part === null) continue;
    const startMin = Math.floor(pt.minute / periodMins) * periodMins;
    const bucketT = session.dayStartUnix + startMin * 60;
    if (regularHoursOnly && !isRegularHours(bucketT)) continue;
    const existing = buckets.get(startMin);
    if (existing) {
      if (part.high > existing.h) existing.h = part.high;
      if (part.low < existing.l) existing.l = part.low;
      existing.c = part.close;
      existing.v += part.volume;
    } else {
      buckets.set(startMin, {
        o: part.open,
        h: part.high,
        l: part.low,
        c: part.close,
        v: part.volume,
      });
    }
  }

  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);
  let current: Bar | null = null;
  for (const startMin of sortedStarts) {
    const agg = buckets.get(startMin)!;
    const bar: Bar = {
      t: session.dayStartUnix + startMin * 60,
      o: agg.o,
      h: agg.h,
      l: agg.l,
      c: agg.c,
      v: agg.v,
    };
    if (startMin === curBucketStart) {
      current = bar;
    } else {
      bars.push(bar);
    }
  }

  return { bars, current };
}
