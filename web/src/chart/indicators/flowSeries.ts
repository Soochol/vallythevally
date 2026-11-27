import type { Bar } from "../../api/generated/Bar";
import type { InvestorNetSharesDay } from "../../api/generated/InvestorNetSharesDay";
import type { KstDate } from "../../api/generated/KstDate";
import type { Period } from "../../api/generated/Period";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import { kstDateOf } from "../barJump";
import { isIntraday } from "../time";
import type { FlowUnit, InvestorFlowSpec, ProgramFlowSpec } from "./kinds";
import type { Point } from "./protocol";

export type InvestorParty = "foreign" | "institution";

export interface FlowEntry {
  readonly bar: number;
  readonly cum: number;
  readonly estimated: boolean;
}

export interface InvestorFlowSeriesData {
  readonly bar: Point[];
  readonly line: Point[];
  readonly cum: Point[];
  readonly byTime: ReadonlyMap<UnixSeconds, FlowEntry>;
}

export interface ProgramFlowEntry {
  readonly bar: number;
  readonly cum: number;
  readonly sharePct: number | null;
}

export interface ProgramFlowSeriesData {
  readonly bar: Point[];
  readonly line: Point[];
  readonly cum: Point[];
  readonly share: Point[];
  readonly byTime: ReadonlyMap<UnixSeconds, ProgramFlowEntry>;
}

const intFmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dec1Fmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dec2Fmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMillionWonValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${dec2Fmt.format(abs / 1_000_000)}조`;
  if (abs >= 100) return `${sign}${dec2Fmt.format(abs / 100)}억`;
  if (abs === 0) return "0백만";
  if (Math.abs(abs - Math.round(abs)) < 0.05) return `${sign}${intFmt.format(Math.round(abs))}백만`;
  return `${sign}${dec1Fmt.format(abs)}백만`;
}

export function formatFlowValue(value: number, unit: FlowUnit): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "eok") return formatMillionWonValue(value * 100);
  const rounded = Math.round(value);
  if (rounded === 0) return "0주";
  const sign = rounded > 0 ? "+" : MINUS;
  const abs = Math.abs(rounded);
  if (abs >= 1e8) return `${sign}${dec2Fmt.format(abs / 1e8)}억주`;
  if (abs >= 1e4) {
    return `${sign}${abs >= 1e6 ? intFmt.format(Math.round(abs / 1e4)) : dec1Fmt.format(abs / 1e4)}만주`;
  }
  return `${sign}${intFmt.format(abs)}주`;
}

function addCalendarSpan(date: KstDate, period: Period): KstDate {
  const d = new Date(`${date}T00:00:00Z`);
  switch (period) {
    case "D":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "W":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "M":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "Q":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "Y":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      d.setUTCDate(d.getUTCDate() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

export function bucketInclusiveEndDate(t: UnixSeconds, period: Period): KstDate {
  const start = kstDateOf(t);
  if (period === "D" || isIntraday(period)) return start;
  const exclusive = new Date(`${addCalendarSpan(start, period)}T00:00:00Z`);
  exclusive.setUTCDate(exclusive.getUTCDate() - 1);
  return exclusive.toISOString().slice(0, 10);
}

function pushSeriesPoint(out: Point[], t: UnixSeconds, v: number, prevHad: boolean): void {
  out.push(prevHad ? { t, v } : { t, v, break: true });
}

export function buildInvestorSeries(
  bars: readonly Bar[],
  period: Period,
  daysByDate: ReadonlyMap<KstDate, InvestorNetSharesDay>,
  estimatedDays: ReadonlySet<KstDate>,
  party: InvestorParty,
  spec: InvestorFlowSpec,
): InvestorFlowSeriesData {
  const barPoints: Point[] = [];
  const linePoints: Point[] = [];
  const cumPoints: Point[] = [];
  const byTime = new Map<UnixSeconds, FlowEntry>();
  if (bars.length === 0 || daysByDate.size === 0) {
    return { bar: barPoints, line: linePoints, cum: cumPoints, byTime };
  }

  const sortedDays = period === "D"
    ? null
    : [...daysByDate.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  let dIdx = 0;
  let runningCum = 0;
  let prevHad = true;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const startDate = kstDateOf(bar.t);
    let shares = 0;
    let matched = false;
    let estimated = false;

    if (sortedDays === null) {
      const day = daysByDate.get(startDate);
      if (day) {
        shares = day[party];
        matched = true;
        estimated = estimatedDays.has(startDate);
      }
    } else {
      const spanEnd = addCalendarSpan(startDate, period);
      const nextDate = i + 1 < bars.length ? kstDateOf(bars[i + 1]!.t) : null;
      const endDate = nextDate !== null && nextDate < spanEnd ? nextDate : spanEnd;
      while (dIdx < sortedDays.length && sortedDays[dIdx]!.day < startDate) dIdx++;
      while (dIdx < sortedDays.length && sortedDays[dIdx]!.day < endDate) {
        const day = sortedDays[dIdx]!;
        shares += day[party];
        if (estimatedDays.has(day.day)) estimated = true;
        matched = true;
        dIdx++;
      }
    }

    if (!matched) {
      prevHad = false;
      continue;
    }

    const barVal = spec.unit === "shares" ? shares : (shares * bar.c) / 1e8;
    runningCum += barVal;
    const primaryVal = spec.displayMode === "both" ? barVal : spec.aggregation === "cumulative" ? runningCum : barVal;

    byTime.set(bar.t, { bar: barVal, cum: runningCum, estimated });
    pushSeriesPoint(barPoints, bar.t, primaryVal, prevHad);
    pushSeriesPoint(linePoints, bar.t, primaryVal, prevHad);
    pushSeriesPoint(cumPoints, bar.t, runningCum, prevHad);
    prevHad = true;
  }

  return { bar: barPoints, line: linePoints, cum: cumPoints, byTime };
}

function dailyProgramShares(pt: ProgramSeriesPoint, close: number): number {
  if (pt.netBuyQty !== 0) return pt.netBuyQty;
  if (close > 0 && pt.netBuyAmountMillionWon !== 0) {
    return Math.round((pt.netBuyAmountMillionWon * 1_000_000) / close);
  }
  return 0;
}

export function buildProgramFlowSeries(
  bars: readonly Bar[],
  period: Period,
  points: ReadonlyMap<UnixSeconds, ProgramSeriesPoint>,
  liveLatestT: UnixSeconds | null,
  spec: ProgramFlowSpec,
): ProgramFlowSeriesData {
  const barPoints: Point[] = [];
  const linePoints: Point[] = [];
  const cumPoints: Point[] = [];
  const sharePoints: Point[] = [];
  const byTime = new Map<UnixSeconds, ProgramFlowEntry>();

  if (points.size === 0) {
    return { bar: barPoints, line: linePoints, cum: cumPoints, share: sharePoints, byTime };
  }

  const intraday = isIntraday(period);
  if (intraday) {
    let prevHad = true;
    let prevShareHad = true;
    let prevDay: KstDate | null = null;
    let prevCum: number | null = null;

    const visit = (t: UnixSeconds, pt: ProgramSeriesPoint) => {
      const day = kstDateOf(t);
      const cumVal = spec.unit === "shares" ? pt.netBuyQty : pt.netBuyAmountMillionWon / 100;
      const barVal = prevDay === day && prevCum !== null ? cumVal - prevCum : cumVal;
      prevDay = day;
      prevCum = cumVal;
      const primaryVal = spec.displayMode === "both" ? barVal : spec.aggregation === "cumulative" ? cumVal : barVal;

      byTime.set(t, { bar: barVal, cum: cumVal, sharePct: pt.programSharePct });
      pushSeriesPoint(barPoints, t, primaryVal, prevHad);
      pushSeriesPoint(linePoints, t, primaryVal, prevHad);
      pushSeriesPoint(cumPoints, t, cumVal, prevHad);
      prevHad = true;

      if (pt.programSharePct !== null) {
        pushSeriesPoint(sharePoints, t, pt.programSharePct, prevShareHad);
        prevShareHad = true;
      } else {
        prevShareHad = false;
      }
    };

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i]!.t;
      const pt = points.get(t);
      if (!pt) {
        prevHad = false;
        prevShareHad = false;
        continue;
      }
      visit(t, pt);
    }

    const lastBarT = bars.at(-1)?.t ?? null;
    if (liveLatestT !== null && (lastBarT === null || liveLatestT > lastBarT)) {
      const livePt = points.get(liveLatestT);
      if (livePt) visit(liveLatestT, livePt);
    }

    return { bar: barPoints, line: linePoints, cum: cumPoints, share: sharePoints, byTime };
  }

  const byDate = new Map<KstDate, ProgramSeriesPoint>();
  const sortedPts: { date: KstDate; pt: ProgramSeriesPoint }[] = [];
  for (const pt of points.values()) {
    const date = kstDateOf(pt.t);
    byDate.set(date, pt);
    sortedPts.push({ date, pt });
  }
  sortedPts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.pt.t - b.pt.t));

  let pIdx = 0;
  let runningCum = 0;
  let prevHad = true;
  let prevShareHad = true;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const startDate = kstDateOf(bar.t);
    const direct = points.get(bar.t) ?? (period === "D" ? byDate.get(startDate) : undefined);

    let barVal = 0;
    let sharePct: number | null = null;
    let matched = false;

    if (direct) {
      barVal = spec.unit === "shares" ? dailyProgramShares(direct, bar.c) : direct.netBuyAmountMillionWon / 100;
      sharePct = direct.programSharePct;
      matched = true;
    } else if (period !== "D") {
      const spanEnd = addCalendarSpan(startDate, period);
      const nextDate = i + 1 < bars.length ? kstDateOf(bars[i + 1]!.t) : null;
      const endDate = nextDate !== null && nextDate < spanEnd ? nextDate : spanEnd;
      let sumMillion = 0;
      let sumShares = 0;
      let grossMillion = 0;
      let tradedMillion = 0;
      let lastShare: number | null = null;
      while (pIdx < sortedPts.length && sortedPts[pIdx]!.date < startDate) pIdx++;
      while (pIdx < sortedPts.length && sortedPts[pIdx]!.date < endDate) {
        const pt = sortedPts[pIdx]!.pt;
        sumMillion += pt.netBuyAmountMillionWon;
        sumShares += dailyProgramShares(pt, bar.c);
        grossMillion += pt.buyAmountMillionWon + pt.sellAmountMillionWon;
        if (pt.dayTradedMillionWon !== undefined && pt.dayTradedMillionWon > 0) tradedMillion += pt.dayTradedMillionWon;
        if (pt.programSharePct !== null) lastShare = pt.programSharePct;
        matched = true;
        pIdx++;
      }
      if (matched) {
        barVal = spec.unit === "shares" ? sumShares : sumMillion / 100;
        sharePct = tradedMillion > 0 ? Math.min(100, Math.max(0, (grossMillion / tradedMillion) * 100)) : lastShare;
      }
    }

    if (!matched) {
      prevHad = false;
      prevShareHad = false;
      continue;
    }

    runningCum += barVal;
    const primaryVal = spec.displayMode === "both" ? barVal : spec.aggregation === "cumulative" ? runningCum : barVal;

    byTime.set(bar.t, { bar: barVal, cum: runningCum, sharePct });
    pushSeriesPoint(barPoints, bar.t, primaryVal, prevHad);
    pushSeriesPoint(linePoints, bar.t, primaryVal, prevHad);
    pushSeriesPoint(cumPoints, bar.t, runningCum, prevHad);
    prevHad = true;

    if (sharePct !== null) {
      pushSeriesPoint(sharePoints, bar.t, sharePct, prevShareHad);
      prevShareHad = true;
    } else {
      prevShareHad = false;
    }
  }

  return { bar: barPoints, line: linePoints, cum: cumPoints, share: sharePoints, byTime };
}
