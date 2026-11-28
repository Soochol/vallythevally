import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { History } from "../../chart/barFeed";
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

export interface TickReplayTransitionInput {
  readonly prevHistory: History | null;
  readonly prevBars: readonly Bar[];
  readonly nextBars: readonly Bar[];
  readonly nextCurrent: Bar | null;
  readonly nextBefore: UnixSeconds | null;
  readonly refit: boolean;
  readonly preserveRange: boolean;
}

export interface TickReplayIndicatorStep {
  readonly history: History;
  readonly bar: Bar;
  readonly kind: "live" | "confirmed";
}

export type TickReplayTransition =
  | { readonly kind: "noop"; readonly history: History }
  | {
      readonly kind: "tail";
      readonly history: History;
      readonly bars: Bar[];
      readonly drawBars: readonly Bar[];
      readonly steps: readonly TickReplayIndicatorStep[];
    }
  | {
      readonly kind: "reset";
      readonly history: History;
      readonly bars: Bar[];
      readonly preserveRange: boolean;
    };

const MAX_INCREMENTAL_APPEND = 10;

function sameBar(a: Bar | undefined, b: Bar | undefined): boolean {
  return (
    a !== undefined
    && b !== undefined
    && a.t === b.t
    && a.o === b.o
    && a.h === b.h
    && a.l === b.l
    && a.c === b.c
    && a.v === b.v
  );
}

function prefixEquals(prev: readonly Bar[], next: readonly Bar[], count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (!sameBar(prev[i], next[i])) return false;
  }
  return true;
}

export function planTickReplayTransition(input: TickReplayTransitionInput): TickReplayTransition {
  const { prevHistory, prevBars, nextBars, nextCurrent, nextBefore, refit, preserveRange } = input;
  const nextHasCurrent = nextCurrent !== null;
  const nextDisplay = nextHasCurrent ? [...nextBars, nextCurrent] : [...nextBars];

  if (!refit && !preserveRange && prevBars.length === 0 && nextDisplay.length === 0) {
    return {
      kind: "noop",
      history: { bars: [], current: null, nextBefore },
    };
  }

  if (refit || preserveRange || prevHistory === null || prevBars.length === 0 || nextDisplay.length === 0) {
    return {
      kind: "reset",
      history: { bars: [...nextBars], current: nextCurrent, nextBefore },
      bars: nextDisplay,
      preserveRange: preserveRange && prevBars.length > 0,
    };
  }

  const prevHadCurrent = prevHistory.current !== null;
  const prevLast = prevBars[prevBars.length - 1]!;
  const nextLast = nextDisplay[nextDisplay.length - 1]!;

  if (
    nextDisplay.length === prevBars.length
    && prevLast.t === nextLast.t
    && prefixEquals(prevBars, nextDisplay, prevBars.length - 1)
  ) {
    const reusedPrefix = prevBars.slice(0, prevBars.length - 1);
    if (sameBar(prevLast, nextLast) && prevHadCurrent === nextHasCurrent) {
      return {
        kind: "noop",
        history: {
          bars: nextHasCurrent ? reusedPrefix : [...reusedPrefix, prevLast],
          current: nextHasCurrent ? prevLast : null,
          nextBefore,
        },
      };
    }
    if (prevHadCurrent && nextHasCurrent) {
      const history: History = { bars: reusedPrefix, current: nextLast, nextBefore };
      return {
        kind: "tail",
        history,
        bars: [...reusedPrefix, nextLast],
        drawBars: [nextLast],
        steps: [{ history, bar: nextLast, kind: "live" }],
      };
    }
    if (prevHadCurrent && !nextHasCurrent) {
      const unchanged = sameBar(prevLast, nextLast);
      const finalBar = unchanged ? prevLast : nextLast;
      const bars = [...reusedPrefix, finalBar];
      const history: History = { bars, current: null, nextBefore };
      return {
        kind: "tail",
        history,
        bars,
        drawBars: unchanged ? [] : [finalBar],
        steps: [{ history, bar: finalBar, kind: "confirmed" }],
      };
    }
  }

  const appended = nextDisplay.length - prevBars.length;
  if (appended >= 1 && appended <= MAX_INCREMENTAL_APPEND) {
    const alignIdx = prevBars.length - 1;
    const alignedNext = nextDisplay[alignIdx]!;
    let monotonic = alignedNext.t === prevLast.t;
    for (let i = prevBars.length; monotonic && i < nextDisplay.length; i++) {
      if (nextDisplay[i]!.t <= nextDisplay[i - 1]!.t) monotonic = false;
    }
    if (
      monotonic
      && prefixEquals(prevBars, nextDisplay, alignIdx)
      && (prevHadCurrent || sameBar(prevLast, alignedNext))
    ) {
      const steps: TickReplayIndicatorStep[] = [];
      const drawBars: Bar[] = [];
      let runningConfirmed: Bar[];

      if (prevHadCurrent) {
        const unchanged = sameBar(prevLast, alignedNext);
        const prevFinal = unchanged ? prevLast : alignedNext;
        runningConfirmed = [...prevBars.slice(0, alignIdx), prevFinal];
        steps.push({
          history: { bars: runningConfirmed, current: null, nextBefore },
          bar: prevFinal,
          kind: "confirmed",
        });
        if (!unchanged) drawBars.push(prevFinal);
      } else {
        runningConfirmed = [...prevBars];
      }

      for (let i = prevBars.length; i < nextDisplay.length; i++) {
        const bar = nextDisplay[i]!;
        const isLive = i === nextDisplay.length - 1 && nextHasCurrent;
        if (isLive) {
          steps.push({
            history: { bars: runningConfirmed, current: bar, nextBefore },
            bar,
            kind: "live",
          });
        } else {
          runningConfirmed = [...runningConfirmed, bar];
          steps.push({
            history: { bars: runningConfirmed, current: null, nextBefore },
            bar,
            kind: "confirmed",
          });
        }
        drawBars.push(bar);
      }

      const finalHistory = steps[steps.length - 1]!.history;
      const finalBars = nextHasCurrent ? [...runningConfirmed, nextLast] : runningConfirmed;
      return {
        kind: "tail",
        history: finalHistory,
        bars: finalBars,
        drawBars,
        steps,
      };
    }
  }

  return {
    kind: "reset",
    history: { bars: [...nextBars], current: nextCurrent, nextBefore },
    bars: nextDisplay,
    preserveRange: false,
  };
}
