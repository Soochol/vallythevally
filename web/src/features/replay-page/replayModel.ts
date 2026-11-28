import type { Bar } from "../../api/generated/Bar";
import type { BookReplayBook } from "../../api/generated/BookReplayBook";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { BookReplayMeta } from "../../api/generated/BookReplayMeta";
import type { BookReplaySpanSummary } from "../../api/generated/BookReplaySpanSummary";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { SymbolKind } from "../../api/generated/SymbolKind";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { kstDateOf } from "../book-replay/replay";
import { tickRuleOf, tickSize } from "../market-window/tick";

export type DeltaMode = "tick" | "min" | "off";

export interface ReplayBookLevel {
  readonly price: number;
  readonly quantity: number;
}

export interface ReplayTrade {
  readonly key: string;
  readonly secondOfDay: number;
  readonly minute: number;
  readonly price: number;
  readonly quantity: number;
  readonly value: number;
  readonly side: "buy" | "sell" | "none";
  readonly whale: boolean;
}

export interface ReplayFrame {
  readonly t: number;
  readonly minute: number;
  readonly price: number | null;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly inGap: boolean;
  readonly singlePrice: boolean;
  readonly asks: readonly ReplayBookLevel[];
  readonly bids: readonly ReplayBookLevel[];
  readonly totalAsk: number;
  readonly totalBid: number;
  readonly bookIndex: number;
  readonly trade: ReplayTrade | null;
  readonly strength: number;
  readonly cumVol: number;
  readonly cumVal: number;
  readonly programNetQty: number | null;
  readonly programNetAmtMillion: number | null;
}

export interface ReplayMinutePoint {
  readonly minute: number;
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
}

export interface ReplayWindow {
  readonly startSec: number;
  readonly endSec: number;
}

export interface ReplaySession {
  readonly date: string;
  readonly dayStartUnix: UnixSeconds;
  readonly sessionStartSec: number;
  readonly sessionEndSec: number;
  readonly previousClose: number | null;
  readonly coveragePct: number;
  readonly tickStepOf: (price: number) => number;
  readonly books: readonly BookReplayBook[];
  readonly frames: readonly ReplayFrame[];
  readonly minutes: readonly ReplayMinutePoint[];
  readonly spans: readonly BookReplaySpanSummary[];
  readonly gapWindows: readonly ReplayWindow[];
  readonly singlePriceWindows: readonly ReplayWindow[];
}

export interface ReplayLadderLevel {
  readonly side: "ask" | "bid";
  readonly price: number | null;
  readonly quantity: number;
  readonly delta: number;
  readonly ratio: number;
  readonly rate: number | null;
  readonly wall: boolean;
  readonly current: boolean;
  readonly lastHit: "buy" | "sell" | null;
  readonly tags: readonly ("open" | "high" | "low")[];
  readonly dimmed: boolean;
}

export interface ReplayLadderSnapshot {
  readonly rows: readonly ReplayLadderLevel[];
  readonly totalAsk: number;
  readonly totalBid: number;
  readonly totalAskDelta: number;
  readonly totalBidDelta: number;
  readonly askPct: number;
  readonly bidPct: number;
  readonly obi: number;
  readonly spreadTicks: number | null;
  readonly spreadWon: number | null;
  readonly singlePrice: boolean;
  readonly inGap: boolean;
}

export interface ReplayTradeSummary {
  readonly rows: readonly ReplayTrade[];
  readonly totalMatching: number;
  readonly net1mQty: number;
  readonly whaleBuy: number;
  readonly whaleSell: number;
}

export const PREMARKET_START_MIN = 8 * 60;
export const REGULAR_START_MIN = 9 * 60;
export const REGULAR_END_MIN = 15 * 60 + 30;
export const AFTERMARKET_END_MIN = 20 * 60;
export const WHALE_VALUE_WON = 50_000_000;
export const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10, 20] as const;

const KST_OFFSET_SECONDS = 9 * 3600;
const MINUS = "\u2212";
const pad2 = (value: number): string => String(value).padStart(2, "0");

export function kstMidnightUnix(yyyymmdd: string): UnixSeconds {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - KST_OFFSET_SECONDS;
}

export function formatIsoDay(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function formatShortDay(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function formatReplayClock(secFloat: number, withMs = true): string {
  const clamped = Math.max(0, Math.min(86_399.999, secFloat));
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const base = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return withMs ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

export function formatReplayHM(secFloat: number): string {
  const clamped = Math.max(0, Math.min(86_399, Math.floor(secFloat)));
  return `${pad2(Math.floor(clamped / 3600))}:${pad2(Math.floor((clamped % 3600) / 60))}`;
}

export function formatSignedQty(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded).toLocaleString("ko-KR")}`;
}

export function formatWonCompact(won: number): string {
  const abs = Math.abs(won);
  const sign = won < 0 ? MINUS : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString("ko-KR")}만`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}`;
}

export function isSinglePriceBook(asks: readonly ReplayBookLevel[], bids: readonly ReplayBookLevel[]): boolean {
  return asks.length > 0 && bids.length > 0 && asks.length <= 3 && bids.length <= 3;
}

export function resolvePreviousClose(dailyBars: readonly Bar[], date: string): number | null {
  let candidate: Bar | null = null;
  for (const bar of dailyBars) {
    const barDate = kstDateOf(bar.t);
    if (barDate < date && (candidate === null || bar.t > candidate.t)) {
      candidate = bar;
    }
  }
  return candidate ? candidate.c : null;
}

function isMinuteCovered(covered: readonly [number, number][], minute: number): boolean {
  for (const [start, end] of covered) {
    if (minute >= start && minute <= end) return true;
  }
  return false;
}

function toLevels(raw: readonly [number, number][]): readonly ReplayBookLevel[] {
  return raw.map(([price, quantity]) => ({ price, quantity }));
}

function kstMinuteOfUnix(unixSec: UnixSeconds, dayStartUnix: UnixSeconds): number {
  return Math.floor((unixSec - dayStartUnix) / 60);
}

function collapseMinuteWindows(minutes: readonly number[]): ReplayWindow[] {
  if (minutes.length === 0) return [];
  const windows: ReplayWindow[] = [];
  let start = minutes[0]!;
  let prev = start;
  for (let i = 1; i < minutes.length; i++) {
    const cur = minutes[i]!;
    if (cur === prev + 1) {
      prev = cur;
    } else {
      windows.push({ startSec: start * 60, endSec: (prev + 1) * 60 });
      start = cur;
      prev = cur;
    }
  }
  windows.push({ startSec: start * 60, endSec: (prev + 1) * 60 });
  return windows;
}

export interface BuildSessionInput {
  readonly day: BookReplayDay;
  readonly bars1m: readonly Bar[];
  readonly quoteTotals: readonly QuoteTotalPoint[];
  readonly programPoints: readonly ProgramSeriesPoint[];
  readonly previousClose: number | null;
  readonly symbolKind: SymbolKind | null;
}

export function buildReplaySession(input: BuildSessionInput): ReplaySession {
  const { day, bars1m, quoteTotals, programPoints, previousClose, symbolKind } = input;
  const dayStartUnix = kstMidnightUnix(day.date);

  let firstDataMin: number | null = null;
  let lastDataMin: number | null = null;
  const includeRange = (lo: number, hi: number) => {
    if (firstDataMin === null || lo < firstDataMin) firstDataMin = lo;
    if (lastDataMin === null || hi > lastDataMin) lastDataMin = hi;
  };
  for (const [lo, hi] of day.covered) includeRange(lo, hi);
  for (const book of day.books) includeRange(book.minute, book.minute);
  for (const tuple of day.trades) includeRange(tuple[0], tuple[0]);

  const firstCovered = day.covered.length > 0 ? day.covered[0]![0] : (firstDataMin ?? PREMARKET_START_MIN);
  const lastCovered = day.covered.length > 0 ? day.covered[day.covered.length - 1]![1] : (lastDataMin ?? REGULAR_END_MIN - 1);
  const startMin = firstDataMin !== null ? Math.min(REGULAR_START_MIN, firstDataMin) : PREMARKET_START_MIN;
  const endMin = Math.max(REGULAR_END_MIN - 1, lastDataMin ?? REGULAR_END_MIN - 1);
  const sessionStartSec = startMin * 60;
  const sessionEndSec = (endMin + 1) * 60;

  const bookByMin = new Map<number, { index: number; book: BookReplayBook }>();
  day.books.forEach((book, index) => {
    bookByMin.set(book.minute, { index, book });
  });

  const barByMin = new Map<number, Bar>();
  for (const bar of bars1m) {
    if (kstDateOf(bar.t) !== day.date) continue;
    const m = kstMinuteOfUnix(bar.t, dayStartUnix);
    if (m >= 0 && m < 1440) barByMin.set(m, bar);
  }

  const quoteTotalByMin = new Map<number, QuoteTotalPoint>();
  for (const point of quoteTotals) {
    const m = kstMinuteOfUnix(point.t, dayStartUnix);
    if (m >= 0 && m < 1440) quoteTotalByMin.set(m, point);
  }

  const programByMin = new Map<number, ProgramSeriesPoint>();
  for (const point of programPoints) {
    const m = kstMinuteOfUnix(point.t, dayStartUnix);
    if (m >= 0 && m < 1440) programByMin.set(m, point);
  }

  const tradesByMin = new Map<number, ReplayTrade[]>();
  day.trades.forEach((tuple, idx) => {
    const [minute, secondOfDay, price, signedQty] = tuple;
    const quantity = Math.abs(signedQty);
    const value = price * quantity;
    const side: ReplayTrade["side"] = signedQty > 0 ? "buy" : signedQty < 0 ? "sell" : "none";
    const trade: ReplayTrade = {
      key: `t-${idx}`,
      secondOfDay,
      minute,
      price,
      quantity,
      value,
      side,
      whale: value >= WHALE_VALUE_WON,
    };
    const bucket = tradesByMin.get(minute);
    if (bucket) bucket.push(trade);
    else tradesByMin.set(minute, [trade]);
  });

  const frames: ReplayFrame[] = [];
  const minutes: ReplayMinutePoint[] = [];
  const gapMinutes: number[] = [];
  const singlePriceMinutes: number[] = [];

  let lastBookIndex = -1;
  let lastAsks: readonly ReplayBookLevel[] = [];
  let lastBids: readonly ReplayBookLevel[] = [];
  let lastTotalAsk = 0;
  let lastTotalBid = 0;
  let lastPrice: number | null = null;
  let dayOpen: number | null = null;
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  let cumBuyQty = 0;
  let cumSellQty = 0;
  let cumVol = 0;
  let cumVal = 0;
  let lastProgramQty: number | null = null;
  let lastProgramAmt: number | null = null;
  let coveredCount = 0;

  const updateOHL = (price: number) => {
    lastPrice = price;
    if (dayOpen === null) dayOpen = price;
    if (dayHigh === null || price > dayHigh) dayHigh = price;
    if (dayLow === null || price < dayLow) dayLow = price;
  };

  const strengthNow = (): number => {
    if (cumBuyQty === 0 && cumSellQty === 0) return 100;
    if (cumSellQty === 0) return 300;
    return Math.min(500, (cumBuyQty / cumSellQty) * 100);
  };

  const totalRangeMinutes = Math.max(1, endMin - startMin + 1);

  for (let m = startMin; m <= endMin; m++) {
    const covered = day.covered.length === 0 ? false : isMinuteCovered(day.covered, m);
    const inGap = !covered && m >= firstCovered && m <= lastCovered;
    if (covered) coveredCount += 1;
    if (inGap) gapMinutes.push(m);

    const prog = programByMin.get(m);
    if (prog !== undefined) {
      lastProgramQty = prog.netBuyQty;
      lastProgramAmt = prog.netBuyAmountMillionWon;
    }

    const minBookEntry = bookByMin.get(m);
    if (minBookEntry !== undefined) {
      lastBookIndex = minBookEntry.index;
      lastAsks = toLevels(minBookEntry.book.asks);
      lastBids = toLevels(minBookEntry.book.bids);
      lastTotalAsk = minBookEntry.book.totalAsk;
      lastTotalBid = minBookEntry.book.totalBid;
    }

    const singlePrice = !inGap && isSinglePriceBook(lastAsks, lastBids);
    if (singlePrice) singlePriceMinutes.push(m);

    const minTrades = tradesByMin.get(m) ?? [];
    minTrades.sort((a, b) => a.secondOfDay - b.secondOfDay);

    const apiBar = barByMin.get(m);
    let synthOpen: number | null = null;
    let synthHigh: number | null = null;
    let synthLow: number | null = null;
    let synthClose: number | null = null;
    let synthVol = 0;

    if (inGap) {
      frames.push({
        t: m * 60,
        minute: m,
        price: lastPrice,
        open: dayOpen,
        high: dayHigh,
        low: dayLow,
        inGap: true,
        singlePrice: false,
        asks: [],
        bids: [],
        totalAsk: 0,
        totalBid: 0,
        bookIndex: -1,
        trade: null,
        strength: strengthNow(),
        cumVol,
        cumVal,
        programNetQty: lastProgramQty,
        programNetAmtMillion: lastProgramAmt,
      });
    } else if (minTrades.length > 0) {
      for (const tr of minTrades) {
        updateOHL(tr.price);
        if (synthOpen === null) synthOpen = tr.price;
        if (synthHigh === null || tr.price > synthHigh) synthHigh = tr.price;
        if (synthLow === null || tr.price < synthLow) synthLow = tr.price;
        synthClose = tr.price;
        synthVol += tr.quantity;
        if (tr.side === "buy") cumBuyQty += tr.quantity;
        else if (tr.side === "sell") cumSellQty += tr.quantity;
        cumVol += tr.quantity;
        cumVal += tr.value;

        frames.push({
          t: tr.secondOfDay,
          minute: m,
          price: tr.price,
          open: dayOpen,
          high: dayHigh,
          low: dayLow,
          inGap: false,
          singlePrice,
          asks: lastAsks,
          bids: lastBids,
          totalAsk: lastTotalAsk,
          totalBid: lastTotalBid,
          bookIndex: lastBookIndex,
          trade: tr,
          strength: strengthNow(),
          cumVol,
          cumVal,
          programNetQty: lastProgramQty,
          programNetAmtMillion: lastProgramAmt,
        });
      }
      if (minBookEntry !== undefined) {
        const lastTr = minTrades[minTrades.length - 1]!;
        if (lastTr.secondOfDay < m * 60 + 59) {
          frames.push({
            t: m * 60 + 59,
            minute: m,
            price: lastPrice,
            open: dayOpen,
            high: dayHigh,
            low: dayLow,
            inGap: false,
            singlePrice,
            asks: lastAsks,
            bids: lastBids,
            totalAsk: lastTotalAsk,
            totalBid: lastTotalBid,
            bookIndex: lastBookIndex,
            trade: null,
            strength: strengthNow(),
            cumVol,
            cumVal,
            programNetQty: lastProgramQty,
            programNetAmtMillion: lastProgramAmt,
          });
        }
      }
    } else if (minBookEntry !== undefined || apiBar !== undefined) {
      const refPrice = apiBar?.c ?? lastPrice ?? lastBids[0]?.price ?? lastAsks[0]?.price ?? null;
      if (refPrice !== null && !singlePrice) updateOHL(refPrice);
      frames.push({
        t: m * 60,
        minute: m,
        price: refPrice,
        open: dayOpen,
        high: dayHigh,
        low: dayLow,
        inGap: false,
        singlePrice,
        asks: lastAsks,
        bids: lastBids,
        totalAsk: lastTotalAsk,
        totalBid: lastTotalBid,
        bookIndex: lastBookIndex,
        trade: null,
        strength: strengthNow(),
        cumVol,
        cumVal,
        programNetQty: lastProgramQty,
        programNetAmtMillion: lastProgramAmt,
      });
    }

    const barOpen = apiBar?.o ?? synthOpen ?? lastPrice;
    const barHigh = apiBar?.h ?? synthHigh ?? lastPrice;
    const barLow = apiBar?.l ?? synthLow ?? lastPrice;
    const barClose = apiBar?.c ?? synthClose ?? lastPrice;
    const barVol = apiBar?.v ?? synthVol;

    if (apiBar !== undefined && synthVol === 0 && apiBar.v > 0) {
      cumVol += apiBar.v;
      cumVal += apiBar.v * apiBar.c;
    }

    const qt = quoteTotalByMin.get(m);
    const totalAsk = inGap ? null : (qt?.ask ?? (lastBookIndex >= 0 ? lastTotalAsk : null));
    const totalBid = inGap ? null : (qt?.bid ?? (lastBookIndex >= 0 ? lastTotalBid : null));
    const totalSum = totalAsk !== null && totalBid !== null ? totalAsk + totalBid : 0;
    const obi = totalSum > 0 && totalAsk !== null && totalBid !== null ? ((totalBid - totalAsk) / totalSum) * 100 : null;
    const vwap = cumVol > 0 ? cumVal / cumVol : barClose;

    minutes.push({
      minute: m,
      sec: m * 60,
      open: barOpen,
      high: barHigh,
      low: barLow,
      close: barClose,
      volume: barVol,
      vwap,
      totalAsk,
      totalBid,
      obi,
      strength: covered ? strengthNow() : null,
      programNetQty: lastProgramQty,
      programNetAmtMillion: lastProgramAmt,
      inGap,
      singlePrice,
    });
  }

  const samplePrices = day.books.slice(0, 5).flatMap((b) => [...b.asks, ...b.bids].map(([p]) => p));
  const rule = tickRuleOf(symbolKind, samplePrices);
  const coveragePct = Math.min(100, Math.round((coveredCount / totalRangeMinutes) * 1000) / 10);

  return {
    date: day.date,
    dayStartUnix,
    sessionStartSec,
    sessionEndSec,
    previousClose,
    coveragePct,
    tickStepOf: (price: number) => tickSize(price, rule),
    books: day.books,
    frames,
    minutes,
    spans: [],
    gapWindows: collapseMinuteWindows(gapMinutes),
    singlePriceWindows: collapseMinuteWindows(singlePriceMinutes),
  };
}

export interface BuildSessionFromMetaInput {
  readonly meta: BookReplayMeta;
  readonly bars1m: readonly Bar[];
  readonly quoteTotals: readonly QuoteTotalPoint[];
  readonly programPoints: readonly ProgramSeriesPoint[];
  readonly previousClose: number | null;
  readonly symbolKind: SymbolKind | null;
}

export function buildReplaySessionFromMeta(input: BuildSessionFromMetaInput): ReplaySession {
  const { meta, bars1m, quoteTotals, programPoints, previousClose, symbolKind } = input;
  const dayStartUnix = kstMidnightUnix(meta.date);

  let firstDataMin: number | null = null;
  let lastDataMin: number | null = null;
  const includeRange = (lo: number, hi: number) => {
    if (firstDataMin === null || lo < firstDataMin) firstDataMin = lo;
    if (lastDataMin === null || hi > lastDataMin) lastDataMin = hi;
  };
  for (const [lo, hi] of meta.covered) includeRange(lo, hi);
  for (const ck of meta.minutes) includeRange(ck.minute, ck.minute);
  for (const span of meta.spans) {
    if (span.bookRows > 0 || span.tradeRows > 0 || span.programRows > 0) {
      includeRange(span.startMinute, span.startMinute + meta.spanMinutes - 1);
    }
  }

  const firstCovered = meta.covered.length > 0 ? meta.covered[0]![0] : (firstDataMin ?? PREMARKET_START_MIN);
  const lastCovered = meta.covered.length > 0 ? meta.covered[meta.covered.length - 1]![1] : (lastDataMin ?? REGULAR_END_MIN - 1);
  const startMin = firstDataMin !== null ? Math.min(REGULAR_START_MIN, firstDataMin) : PREMARKET_START_MIN;
  const endMin = Math.max(REGULAR_END_MIN - 1, lastDataMin ?? REGULAR_END_MIN - 1);
  const sessionStartSec = startMin * 60;
  const sessionEndSec = (endMin + 1) * 60;

  const ckByMin = new Map(meta.minutes.map((m) => [m.minute, m]));
  const barByMin = new Map<number, Bar>();
  for (const bar of bars1m) {
    if (kstDateOf(bar.t) !== meta.date) continue;
    const m = kstMinuteOfUnix(bar.t, dayStartUnix);
    if (m >= 0 && m < 1440) barByMin.set(m, bar);
  }
  const quoteTotalByMin = new Map<number, QuoteTotalPoint>();
  for (const pt of quoteTotals) {
    const m = kstMinuteOfUnix(pt.t, dayStartUnix);
    if (m >= 0 && m < 1440) quoteTotalByMin.set(m, pt);
  }
  const programByMin = new Map<number, ProgramSeriesPoint>();
  for (const pt of programPoints) {
    const m = kstMinuteOfUnix(pt.t, dayStartUnix);
    if (m >= 0 && m < 1440) programByMin.set(m, pt);
  }

  const minutes: ReplayMinutePoint[] = [];
  const gapMinutes: number[] = [];
  const singlePriceMinutes: number[] = [];
  let coveredCount = 0;
  let lastPrice: number | null = null;
  let lastProgramQty: number | null = null;
  let lastProgramAmt: number | null = null;
  let lastCumVol = 0;
  let lastCumVal = 0;
  let lastStrength = 100;

  for (let m = startMin; m <= endMin; m++) {
    const covered = meta.covered.length === 0 ? false : isMinuteCovered(meta.covered, m);
    const inGap = !covered && m >= firstCovered && m <= lastCovered;
    if (covered) coveredCount += 1;
    if (inGap) gapMinutes.push(m);

    const ck = ckByMin.get(m);
    const apiBar = barByMin.get(m);
    const qt = quoteTotalByMin.get(m);
    const prog = programByMin.get(m);

    const open: number | null = ck?.open ?? apiBar?.o ?? lastPrice;
    const high: number | null = ck?.high ?? apiBar?.h ?? lastPrice;
    const low: number | null = ck?.low ?? apiBar?.l ?? lastPrice;
    const close: number | null = ck?.close ?? apiBar?.c ?? lastPrice;
    const volume = ck ? ck.volume : (apiBar?.v ?? 0);
    if (close !== null) lastPrice = close;

    if (ck !== undefined) {
      lastCumVol = ck.cumVol + ck.volume;
      lastCumVal = ck.cumVal + (close !== null ? close * ck.volume : 0);
      if (ck.cumBuyQty > 0 || ck.cumSellQty > 0) {
        lastStrength = ck.cumSellQty === 0 ? 300 : Math.min(500, (ck.cumBuyQty / ck.cumSellQty) * 100);
      }
      if (ck.programNetQty !== null) lastProgramQty = ck.programNetQty;
      if (ck.programNetAmtMillion !== null) lastProgramAmt = ck.programNetAmtMillion;
    }
    if (prog !== undefined) {
      lastProgramQty = prog.netBuyQty;
      lastProgramAmt = prog.netBuyAmountMillionWon;
    }

    const singlePrice = !inGap && Boolean(ck?.singlePrice);
    if (singlePrice) singlePriceMinutes.push(m);

    const totalAsk = inGap ? null : (ck?.totalAsk ?? qt?.ask ?? null);
    const totalBid = inGap ? null : (ck?.totalBid ?? qt?.bid ?? null);
    const totalSum = totalAsk !== null && totalBid !== null ? totalAsk + totalBid : 0;
    const obi = totalSum > 0 && totalAsk !== null && totalBid !== null ? ((totalBid - totalAsk) / totalSum) * 100 : null;
    const vwap = lastCumVol > 0 ? lastCumVal / lastCumVol : close;

    minutes.push({
      minute: m,
      sec: m * 60,
      open,
      high,
      low,
      close,
      volume,
      vwap,
      totalAsk,
      totalBid,
      obi,
      strength: covered ? lastStrength : null,
      programNetQty: lastProgramQty,
      programNetAmtMillion: lastProgramAmt,
      inGap,
      singlePrice,
    });
  }

  const samplePrices = meta.minutes
    .slice(0, 10)
    .map((m) => m.close ?? m.open ?? 0)
    .filter((p) => p > 0);
  const rule = tickRuleOf(symbolKind, samplePrices.length > 0 ? samplePrices : (previousClose ? [previousClose] : []));
  const totalRangeMinutes = Math.max(1, endMin - startMin + 1);
  const coveragePct = Math.min(100, Math.round((coveredCount / totalRangeMinutes) * 1000) / 10);

  return {
    date: meta.date,
    dayStartUnix,
    sessionStartSec,
    sessionEndSec,
    previousClose,
    coveragePct,
    tickStepOf: (price: number) => tickSize(price, rule),
    books: [],
    frames: [],
    minutes,
    spans: meta.spans,
    gapWindows: collapseMinuteWindows(gapMinutes),
    singlePriceWindows: collapseMinuteWindows(singlePriceMinutes),
  };
}

export function frameIndexAt(frames: readonly ReplayFrame[], cursorSec: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid]!.t <= cursorSec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function stepTickSec(frames: readonly ReplayFrame[], cursorSec: number, dir: -1 | 1): number {
  if (frames.length === 0) return cursorSec;
  const idx = frameIndexAt(frames, cursorSec);
  const next = Math.max(0, Math.min(frames.length - 1, idx + dir));
  return frames[next]!.t;
}

export function clampCursorSec(sec: number, startSec: number, endSec: number): number {
  return Math.max(startSec, Math.min(Math.max(startSec, endSec - 0.1), sec));
}

function findReferenceBook(books: readonly BookReplayBook[], currentIndex: number, mode: DeltaMode): BookReplayBook | null {
  if (mode === "off" || currentIndex <= 0) return null;
  const current = books[currentIndex];
  if (!current) return null;
  if (mode === "tick") return books[currentIndex - 1] ?? null;
  const targetMinute = current.minute - 1;
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (books[i]!.minute <= targetMinute) return books[i]!;
  }
  return books[0] ?? null;
}

export function computeLadderSnapshot(
  session: ReplaySession,
  frameIndex: number,
  deltaMode: DeltaMode,
): ReplayLadderSnapshot {
  const frame = frameIndex >= 0 ? session.frames[frameIndex] : undefined;
  if (!frame || frame.inGap) {
    const emptyRows: ReplayLadderLevel[] = Array.from({ length: 20 }, (_, i) => ({
      side: i < 10 ? "ask" : "bid",
      price: null,
      quantity: 0,
      delta: 0,
      ratio: 0,
      rate: null,
      wall: false,
      current: false,
      lastHit: null,
      tags: [],
      dimmed: true,
    }));
    return {
      rows: emptyRows,
      totalAsk: 0,
      totalBid: 0,
      totalAskDelta: 0,
      totalBidDelta: 0,
      askPct: 50,
      bidPct: 50,
      obi: 0,
      spreadTicks: null,
      spreadWon: null,
      singlePrice: false,
      inGap: Boolean(frame?.inGap),
    };
  }

  const refBook = findReferenceBook(session.books, frame.bookIndex, deltaMode);
  const refAsks = new Map(refBook?.asks.map(([p, q]) => [p, q]) ?? []);
  const refBids = new Map(refBook?.bids.map(([p, q]) => [p, q]) ?? []);

  const allQty = [...frame.asks, ...frame.bids].map((l) => l.quantity);
  const maxQty = Math.max(1, ...allQty);
  const avgQty = allQty.length >= 4 ? allQty.reduce((a, b) => a + b, 0) / allQty.length : Infinity;
  const wallThreshold = avgQty * 2.5;

  const rows: ReplayLadderLevel[] = [];
  for (let i = 0; i < 20; i++) {
    const side: "ask" | "bid" = i < 10 ? "ask" : "bid";
    const levelIdx = side === "ask" ? 9 - i : i - 10;
    const level = side === "ask" ? frame.asks[levelIdx] : frame.bids[levelIdx];
    if (!level) {
      rows.push({
        side,
        price: null,
        quantity: 0,
        delta: 0,
        ratio: 0,
        rate: null,
        wall: false,
        current: false,
        lastHit: null,
        tags: [],
        dimmed: frame.singlePrice,
      });
      continue;
    }

    const refMap = side === "ask" ? refAsks : refBids;
    const prevQty = refMap.get(level.price);
    const delta = deltaMode === "off" || prevQty === undefined ? 0 : level.quantity - prevQty;
    const rate = session.previousClose && session.previousClose > 0
      ? ((level.price - session.previousClose) / session.previousClose) * 100
      : null;

    const tags: ("open" | "high" | "low")[] = [];
    if (frame.open === level.price) tags.push("open");
    if (frame.high === level.price) tags.push("high");
    if (frame.low === level.price) tags.push("low");

    const current = !frame.singlePrice && frame.price === level.price;
    const lastHit = current && frame.trade && frame.trade.side !== "none" ? frame.trade.side : null;

    rows.push({
      side,
      price: level.price,
      quantity: level.quantity,
      delta,
      ratio: Math.min(1, level.quantity / maxQty),
      rate,
      wall: !frame.singlePrice && level.quantity >= wallThreshold,
      current,
      lastHit,
      tags,
      dimmed: false,
    });
  }

  const totalAsk = frame.totalAsk;
  const totalBid = frame.totalBid;
  const totalAskDelta = refBook && deltaMode !== "off" ? totalAsk - refBook.totalAsk : 0;
  const totalBidDelta = refBook && deltaMode !== "off" ? totalBid - refBook.totalBid : 0;
  const sum = totalAsk + totalBid;
  const askPct = sum > 0 ? Math.round((totalAsk / sum) * 100) : 50;
  const bidPct = sum > 0 ? 100 - askPct : 50;
  const obi = sum > 0 ? (totalBid - totalAsk) / sum : 0;

  let spreadWon: number | null = null;
  let spreadTicks: number | null = null;
  if (frame.asks[0] && frame.bids[0]) {
    spreadWon = frame.asks[0].price - frame.bids[0].price;
    const step = session.tickStepOf(frame.bids[0].price);
    spreadTicks = step > 0 ? Math.max(0, Math.round(spreadWon / step)) : null;
  }

  return {
    rows,
    totalAsk,
    totalBid,
    totalAskDelta,
    totalBidDelta,
    askPct,
    bidPct,
    obi,
    spreadTicks,
    spreadWon,
    singlePrice: frame.singlePrice,
    inGap: false,
  };
}

export function filterRecentTrades(
  frames: readonly ReplayFrame[],
  frameIndex: number,
  minValueWon: number,
  limit = 500,
): ReplayTradeSummary {
  if (frameIndex < 0 || frames.length === 0) {
    return { rows: [], totalMatching: 0, net1mQty: 0, whaleBuy: 0, whaleSell: 0 };
  }
  const currentSec = frames[frameIndex]!.t;
  const oneMinAgo = currentSec - 60;
  const rows: ReplayTrade[] = [];
  let totalMatching = 0;
  let net1mQty = 0;
  let whaleBuy = 0;
  let whaleSell = 0;

  for (let i = frameIndex; i >= 0; i--) {
    const tr = frames[i]!.trade;
    if (!tr) continue;
    if (tr.secondOfDay >= oneMinAgo) {
      if (tr.side === "buy") net1mQty += tr.quantity;
      else if (tr.side === "sell") net1mQty -= tr.quantity;
    }
    if (tr.whale) {
      if (tr.side === "buy") whaleBuy += 1;
      else if (tr.side === "sell") whaleSell += 1;
    }
    if (tr.value >= minValueWon) {
      totalMatching += 1;
      if (rows.length < limit) {
        rows.push(tr);
      }
    }
  }

  return { rows, totalMatching, net1mQty, whaleBuy, whaleSell };
}
