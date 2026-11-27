import type { Venue } from "../../api/generated/Venue";
import {
  HOLD_LABELS,
  PAIRS,
  RET_EDGES,
  RET_FULL,
  SESSIONS,
  STYLE_SHORT,
  type JournalBar,
  type JournalFill,
  type JournalFilterKey,
  type JournalFilters,
  type JournalGrain,
  type JournalMetric,
  type JournalNote,
  type JournalPeriod,
  type JournalSummary,
  type JournalTf,
  type JournalTrade,
  type StoredDayExecutions,
} from "./journalTypes";

export const MINUS = "−";
export const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;
const FEE_RATE = 0.00015;
const TAX_RATE = 0.0018;
const SWING_LOOKBACK_DAYS = 14;

export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function formatWon(value: number, signed = true): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? MINUS : signed && rounded > 0 ? "+" : "";
  return `${sign}${Math.abs(rounded).toLocaleString("ko-KR")}`;
}

export function formatCompactWon(value: number, signed = true): string {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? MINUS : signed && rounded > 0 ? "+" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString("ko-KR")}만`;
  return `${sign}${abs.toLocaleString("ko-KR")}원`;
}

export function formatPct(value: number, digits = 2): string {
  const abs = Math.abs(value).toFixed(digits);
  const zero = Number(abs) === 0;
  const sign = value < 0 && !zero ? MINUS : value > 0 && !zero ? "+" : "";
  return `${sign}${abs}%`;
}

export function toneClass(value: number): "up" | "dn" | "" {
  if (value > 0) return "up";
  if (value < 0) return "dn";
  return "";
}

export function todayKstIso(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600_000);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}`;
}

export function parseDayUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1);
}

export function formatUtcMsToDay(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function dayOfWeek(day: string): number {
  return new Date(parseDayUtcMs(day)).getUTCDay();
}

export function dayShortLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${m ?? 1}.${pad2(d ?? 1)}`;
}

export function tradingDaysBetween(d0: string, d1: string): number {
  if (d0 === d1) return 0;
  let cur = parseDayUtcMs(d0);
  const end = parseDayUtcMs(d1);
  if (cur > end) return 0;
  let count = 0;
  while (cur < end) {
    cur += 864e5;
    const dow = new Date(cur).getUTCDay();
    if (dow >= 1 && dow <= 5) count += 1;
  }
  return count;
}

export function parseTimeToSeconds(raw: string): number {
  const clean = raw.replace(/\D/g, "");
  if (clean.length >= 6) {
    const h = Number(clean.slice(0, 2));
    const m = Number(clean.slice(2, 4));
    const s = Number(clean.slice(4, 6));
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) return h * 3600 + m * 60 + s;
  }
  if (clean.length >= 4) {
    const h = Number(clean.slice(0, 2));
    const m = Number(clean.slice(2, 4));
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 3600 + m * 60;
  }
  const parts = raw.split(":").map(Number);
  return (parts[0] ?? 9) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
}

export function parseTimeToMinutes(raw: string): number {
  return Math.floor(parseTimeToSeconds(raw) / 60);
}

export function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.floor(minutes));
  return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`;
}

export function slotIdxOf(minutes: number, venue: Venue): number {
  if (minutes < 540) return 0;
  if (minutes >= 935 || (venue === "nxt" && minutes >= 930)) return 7;
  if (minutes >= 920) return 6;
  if (minutes >= 810) return 5;
  if (minutes >= 690) return 4;
  if (minutes >= 600) return 3;
  if (minutes >= 570) return 2;
  return 1;
}

export function pairIdxOf(swing: boolean, venue: Venue, entrySlot: number, exitSlot: number): number {
  if (swing) return 2;
  if (venue === "nxt" || entrySlot === 0 || entrySlot === 7) return 6;
  if (entrySlot === 1 && exitSlot === 1) return 0;
  if (entrySlot === 1) return 1;
  if (entrySlot === 2 || entrySlot === 3) return 3;
  if (entrySlot === 4) return 4;
  return 5;
}

export function holdBucketOf(swing: boolean, holdDays: number, holdMin: number): number {
  if (swing) return holdDays <= 3 ? 4 : 5;
  if (holdMin <= 5) return 0;
  if (holdMin <= 30) return 1;
  if (holdMin <= 120) return 2;
  return 3;
}

export function retBucketOf(retPct: number): number {
  let i = 0;
  while (i < RET_EDGES.length && retPct >= RET_EDGES[i]!) i += 1;
  return i;
}

export function tfStepMinutes(tf: JournalTf): number {
  if (tf === "1") return 1;
  if (tf === "3") return 3;
  if (tf === "5") return 5;
  if (tf === "10") return 10;
  return 1440;
}

export function autoTfOf(trade: JournalTrade): JournalTf {
  if (trade.swing) return "D";
  if (trade.holdMin <= 15) return "1";
  if (trade.holdMin <= 40) return "3";
  if (trade.holdMin <= 120) return "5";
  return "10";
}

export function formatHoldDuration(trade: JournalTrade): string {
  if (trade.swing) return `${trade.holdDays}거래일`;
  if (trade.holdMin < 60) return `${trade.holdMin}분`;
  const h = Math.floor(trade.holdMin / 60);
  const m = trade.holdMin % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

export function tradePnl(trade: JournalTrade, afterCost: boolean): number {
  return afterCost ? trade.net : trade.gross;
}

export function tradeRetPct(trade: JournalTrade, afterCost: boolean): number {
  return trade.buyAmt > 0 ? (tradePnl(trade, afterCost) / trade.buyAmt) * 100 : 0;
}

export function resolveNote(trade: JournalTrade, notes: Record<string, JournalNote>): JournalNote {
  const saved = notes[trade.id];
  return {
    memo: saved?.memo !== undefined ? saved.memo : trade.defaultMemo,
    tags: saved?.tags !== undefined ? saved.tags : trade.defaultTags,
  };
}

export function buildRoundTrips(history: readonly StoredDayExecutions[]): readonly JournalTrade[] {
  interface RawFill {
    day: string;
    minutes: number;
    ord: number;
    code: string;
    name: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    orderNo: string;
    venue: Venue;
    mfePct: number | null;
    maePct: number | null;
    fillAt: number | null;
  }

  const allFills: RawFill[] = [];
  for (const dayEntry of history) {
    const dayMs = parseDayUtcMs(dayEntry.day);
    for (const ex of dayEntry.executions) {
      if (ex.quantity <= 0 || ex.price <= 0) continue;
      const seconds = parseTimeToSeconds(ex.time);
      const minutes = Math.floor(seconds / 60);
      allFills.push({
        day: dayEntry.day,
        minutes,
        ord: Math.floor(dayMs / 864e5) * 86400 + seconds,
        code: ex.code,
        name: ex.name,
        side: ex.side,
        qty: ex.quantity,
        price: ex.price,
        orderNo: ex.orderNo,
        venue: ex.venue,
        mfePct: ex.mfePct,
        maePct: ex.maePct,
        fillAt: ex.fillAt,
      });
    }
  }

  allFills.sort(
    (a, b) =>
      a.ord - b.ord ||
      a.orderNo.localeCompare(b.orderNo, undefined, { numeric: true }) ||
      (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1),
  );

  interface OpenLot {
    fill: JournalFill;
    rem: number;
    mfePct: number | null;
    maePct: number | null;
  }

  const queues = new Map<string, OpenLot[]>();
  interface PendingRoundTrip {
    code: string;
    name: string;
    venue: Venue;
    buys: JournalFill[];
    sells: JournalFill[];
    mfeCandidates: number[];
    maeCandidates: number[];
  }
  const active = new Map<string, PendingRoundTrip>();
  const trades: JournalTrade[] = [];

  const finalize = (rt: PendingRoundTrip, seq: number): JournalTrade => {
    const firstBuy = rt.buys[0]!;
    const lastSell = rt.sells[rt.sells.length - 1]!;
    const qty = rt.buys.reduce((s, f) => s + f.qty, 0);
    const buyAmt = rt.buys.reduce((s, f) => s + f.price * f.qty, 0);
    const sellAmt = rt.sells.reduce((s, f) => s + f.price * f.qty, 0);
    const fee = Math.floor((buyAmt + sellAmt) * FEE_RATE);
    const tax = Math.floor(sellAmt * TAX_RATE);
    const cost = fee + tax;
    const gross = sellAmt - buyAmt;
    const net = gross - cost;
    const avgBuy = qty > 0 ? buyAmt / qty : firstBuy.price;
    const avgSell = qty > 0 ? sellAmt / qty : lastSell.price;
    const exitRet = avgBuy > 0 ? (avgSell / avgBuy - 1) * 100 : 0;

    const swing = firstBuy.day !== lastSell.day;
    const holdDays = tradingDaysBetween(firstBuy.day, lastSell.day);
    const holdMin = swing ? Math.max(1, holdDays) * 390 : Math.max(1, lastSell.minutes - firstBuy.minutes);
    const holdBucket = holdBucketOf(swing, holdDays, holdMin);

    const styleIdx: 0 | 1 | 2 =
      rt.buys.length <= 1 ? 0 : rt.buys[1]!.price >= rt.buys[0]!.price ? 1 : 2;

    const entrySlot = slotIdxOf(firstBuy.minutes, rt.venue);
    const exitSlot = slotIdxOf(lastSell.minutes, rt.venue);
    const slotSet = new Set<number>();
    for (const f of rt.buys) slotSet.add(slotIdxOf(f.minutes, rt.venue));
    for (const f of rt.sells) slotSet.add(slotIdxOf(f.minutes, rt.venue));
    const pairIdx = pairIdxOf(swing, rt.venue, entrySlot, exitSlot);

    const allPrices = [...rt.buys.map((f) => f.price), ...rt.sells.map((f) => f.price)];
    const highRet = avgBuy > 0 ? (Math.max(...allPrices) / avgBuy - 1) * 100 : 0;
    const lowRet = avgBuy > 0 ? (Math.min(...allPrices) / avgBuy - 1) * 100 : 0;
    const mfe = rt.mfeCandidates.length > 0 ? Math.max(highRet, exitRet, ...rt.mfeCandidates) : Math.max(0, highRet, exitRet);
    const mae = rt.maeCandidates.length > 0 ? Math.min(lowRet, exitRet, ...rt.maeCandidates) : Math.min(0, lowRet, exitRet);

    const tags: string[] = [];
    if (swing) tags.push("스윙");
    if (entrySlot === 1 && net > 0) tags.push("돌파매매");
    if (entrySlot === 6) tags.push("종가베팅");
    if (styleIdx === 2 && net < 0) tags.push("손절지연");

    return {
      id: `${rt.code}:${firstBuy.day}:${firstBuy.orderNo}:${lastSell.orderNo}:${seq}`,
      code: rt.code,
      name: rt.name,
      venue: rt.venue,
      entryDay: firstBuy.day,
      exitDay: lastSell.day,
      entryMin: firstBuy.minutes,
      exitMin: lastSell.minutes,
      entryOrd: Math.floor(parseDayUtcMs(firstBuy.day) / 864e5) * 1440 + firstBuy.minutes,
      exitOrd: Math.floor(parseDayUtcMs(lastSell.day) / 864e5) * 1440 + lastSell.minutes,
      swing,
      holdDays,
      holdMin,
      holdBucket,
      buys: rt.buys,
      sells: rt.sells,
      qty,
      buyAmt,
      sellAmt,
      fee,
      tax,
      cost,
      gross,
      net,
      avgBuy,
      avgSell,
      mfe,
      mae,
      exitRet,
      styleIdx,
      entrySlot,
      exitSlot,
      fillSlots: [...slotSet],
      pairIdx,
      defaultTags: tags,
      defaultMemo: "",
      demoSeed: null,
    };
  };

  for (const f of allFills) {
    const q = queues.get(f.code) ?? [];
    if (!queues.has(f.code)) queues.set(f.code, q);

    if (f.side === "buy") {
      const fill: JournalFill = {
        side: "buy",
        day: f.day,
        minutes: f.minutes,
        timeLabel: formatMinutes(f.minutes),
        price: f.price,
        qty: f.qty,
        orderNo: f.orderNo,
        fillAt: f.fillAt,
      };
      q.push({ fill, rem: f.qty, mfePct: f.mfePct, maePct: f.maePct });
      continue;
    }

    let remSell = f.qty;
    while (remSell > 0 && q.length > 0) {
      const head = q[0]!;
      const matched = Math.min(remSell, head.rem);
      let rt = active.get(f.code);
      if (rt === undefined) {
        rt = { code: f.code, name: f.name, venue: f.venue, buys: [], sells: [], mfeCandidates: [], maeCandidates: [] };
        active.set(f.code, rt);
      }

      const lastBuy = rt.buys[rt.buys.length - 1];
      if (lastBuy !== undefined && lastBuy.orderNo === head.fill.orderNo && lastBuy.day === head.fill.day) {
        rt.buys[rt.buys.length - 1] = { ...lastBuy, qty: lastBuy.qty + matched };
      } else {
        rt.buys.push({ ...head.fill, qty: matched });
      }
      if (head.mfePct !== null) rt.mfeCandidates.push(head.mfePct);
      if (head.maePct !== null) rt.maeCandidates.push(head.maePct);

      const lastSell = rt.sells[rt.sells.length - 1];
      if (lastSell !== undefined && lastSell.orderNo === f.orderNo && lastSell.day === f.day) {
        rt.sells[rt.sells.length - 1] = { ...lastSell, qty: lastSell.qty + matched };
      } else {
        rt.sells.push({
          side: "sell",
          day: f.day,
          minutes: f.minutes,
          timeLabel: formatMinutes(f.minutes),
          price: f.price,
          qty: matched,
          orderNo: f.orderNo,
          fillAt: f.fillAt,
        });
      }
      if (f.mfePct !== null) rt.mfeCandidates.push(f.mfePct);
      if (f.maePct !== null) rt.maeCandidates.push(f.maePct);

      head.rem -= matched;
      remSell -= matched;
      if (head.rem === 0) q.shift();
      if (q.length === 0) {
        trades.push(finalize(rt, trades.length));
        active.delete(f.code);
      }
    }
  }

  for (const rt of active.values()) {
    if (rt.sells.length > 0) trades.push(finalize(rt, trades.length));
  }

  return trades.sort((a, b) => a.exitOrd - b.exitOrd);
}

export function computePeriodRange(
  period: JournalPeriod,
  allTrades: readonly JournalTrade[],
  today: string,
): readonly [string, string] {
  const anchor = period.anchor || today;
  if (period.type === "day") return [anchor, anchor];
  if (period.type === "all") {
    const first = allTrades[0]?.exitDay ?? anchor;
    const last = allTrades[allTrades.length - 1]?.exitDay ?? today;
    return [first <= today ? first : today, last >= today ? last : today];
  }
  const ms = parseDayUtcMs(anchor);
  const dt = new Date(ms);
  if (period.type === "week") {
    const dow = dt.getUTCDay();
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const mon = ms + diffToMon * 864e5;
    const fri = mon + 4 * 864e5;
    return [formatUtcMsToDay(mon), formatUtcMsToDay(fri)];
  }
  if (period.type === "month") {
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const first = Date.UTC(y, m, 1);
    const last = Date.UTC(y, m + 1, 0);
    return [formatUtcMsToDay(first), formatUtcMsToDay(last)];
  }
  const y = dt.getUTCFullYear();
  return [`${y}-01-01`, `${y}-12-31`];
}

function shiftIsoDay(day: string, deltaDays: number): string {
  return formatUtcMsToDay(parseDayUtcMs(day) + deltaDays * 864e5);
}

function latestWeekday(day: string): string {
  let ms = parseDayUtcMs(day);
  while (new Date(ms).getUTCDay() === 0 || new Date(ms).getUTCDay() === 6) {
    ms -= 864e5;
  }
  return formatUtcMsToDay(ms);
}

export function isPeriodAtToday(
  period: JournalPeriod,
  range: readonly [string, string],
  today: string,
): boolean {
  if (period.type === "all") return true;
  if (period.type === "week") {
    const [, currentWeekEnd] = computePeriodRange({ type: "week", anchor: today }, [], today);
    return range[1] >= currentWeekEnd;
  }
  if (period.type === "day") {
    return range[1] >= latestWeekday(today);
  }
  return range[1] >= today;
}

export function computeHistoryQueryRange(
  period: JournalPeriod,
  today: string,
): readonly [string, string] | null {
  if (period.type === "all") return null;
  const anchor = period.anchor || today;
  const ms = parseDayUtcMs(anchor);
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  if (period.type === "year") return [shiftIsoDay(`${y}-01-01`, -SWING_LOOKBACK_DAYS), `${y}-12-31`];
  const m = dt.getUTCMonth();
  const monthFirst = formatUtcMsToDay(Date.UTC(y, m, 1));
  const monthLast = formatUtcMsToDay(Date.UTC(y, m + 1, 0));
  if (period.type === "week") {
    const [weekStart, weekEnd] = computePeriodRange(period, [], today);
    const start = weekStart < monthFirst ? weekStart : monthFirst;
    const end = weekEnd > monthLast ? weekEnd : monthLast;
    return [shiftIsoDay(start, -SWING_LOOKBACK_DAYS), end];
  }
  return [shiftIsoDay(monthFirst, -SWING_LOOKBACK_DAYS), monthLast];
}

export function stepPeriodAnchor(period: JournalPeriod, dir: -1 | 1, today: string): string {
  const ms = parseDayUtcMs(period.anchor || today);
  const dt = new Date(ms);
  if (period.type === "day") {
    let next = ms + dir * 864e5;
    while (new Date(next).getUTCDay() === 0 || new Date(next).getUTCDay() === 6) next += dir * 864e5;
    const day = formatUtcMsToDay(next);
    return day > today ? today : day;
  }
  if (period.type === "week") {
    const day = formatUtcMsToDay(ms + dir * 7 * 864e5);
    return day > today ? today : day;
  }
  if (period.type === "month") {
    const next = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + dir, 15);
    const day = formatUtcMsToDay(next);
    return day > today ? today : day;
  }
  const nextYear = dt.getUTCFullYear() + dir;
  const day = `${nextYear}-06-15`;
  return day > today ? today : day;
}

export function formatPeriodLabel(period: JournalPeriod, range: readonly [string, string]): string {
  const [start, end] = range;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (period.type === "day") {
    return `${sy}.${pad2(sm ?? 1)}.${pad2(sd ?? 1)} (${DOW_KO[dayOfWeek(start)]})`;
  }
  if (period.type === "week") {
    return sm === em ? `${sm}월 ${sd}일 – ${ed}일` : `${sm}월 ${sd}일 – ${em}월 ${ed}일`;
  }
  if (period.type === "month") return `${sy}년 ${sm}월`;
  if (period.type === "year") return `${sy}년`;
  return `${sy}.${pad2(sm ?? 1)} – ${ey}.${pad2(em ?? 1)}`;
}

export function matchTradeFilter(
  trade: JournalTrade,
  filters: JournalFilters,
  notes: Record<string, JournalNote>,
  afterCost: boolean,
  exceptKey: JournalFilterKey | null = null,
): boolean {
  if (exceptKey !== "slot" && filters.slot !== null && !trade.fillSlots.includes(filters.slot)) return false;
  if (exceptKey !== "pair" && filters.pair !== null && trade.pairIdx !== filters.pair) return false;
  if (exceptKey !== "hold" && filters.hold !== null && trade.holdBucket !== filters.hold) return false;
  if (exceptKey !== "ret" && filters.ret !== null && retBucketOf(tradeRetPct(trade, afterCost)) !== filters.ret) return false;
  if (exceptKey !== "style" && filters.style !== null && trade.styleIdx !== filters.style) return false;
  if (exceptKey !== "tag" && filters.tag !== null && !resolveNote(trade, notes).tags.includes(filters.tag)) return false;
  if (exceptKey !== "sym" && filters.sym !== null && trade.code !== filters.sym) return false;
  return true;
}

export function activeFilterTokens(
  filters: JournalFilters,
  symbolNames: ReadonlyMap<string, string>,
): readonly { readonly key: JournalFilterKey; readonly label: string }[] {
  const out: { readonly key: JournalFilterKey; readonly label: string }[] = [];
  if (filters.slot !== null) out.push({ key: "slot", label: `시간대 ${SESSIONS[filters.slot]?.short ?? ""}` });
  if (filters.pair !== null) out.push({ key: "pair", label: PAIRS[filters.pair]?.label ?? "" });
  if (filters.hold !== null) out.push({ key: "hold", label: `보유 ${HOLD_LABELS[filters.hold] ?? ""}` });
  if (filters.ret !== null) out.push({ key: "ret", label: `수익률 ${RET_FULL[filters.ret] ?? ""}` });
  if (filters.style !== null) out.push({ key: "style", label: STYLE_SHORT[filters.style] ?? "" });
  if (filters.tag !== null) out.push({ key: "tag", label: `#${filters.tag}` });
  if (filters.sym !== null) out.push({ key: "sym", label: symbolNames.get(filters.sym) ?? filters.sym });
  return out;
}

export function aggregateSummary(trades: readonly JournalTrade[], afterCost: boolean): JournalSummary {
  let buyAmt = 0;
  let sellAmt = 0;
  let fee = 0;
  let tax = 0;
  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;
  let swingCount = 0;
  let cum = 0;
  let peak = 0;
  let mdd = 0;

  for (const t of trades) {
    buyAmt += t.buyAmt;
    sellAmt += t.sellAmt;
    fee += t.fee;
    tax += t.tax;
    if (t.swing) swingCount += 1;
    const p = tradePnl(t, afterCost);
    if (p > 0) {
      wins += 1;
      winSum += p;
    } else if (p < 0) {
      losses += 1;
      lossSum += p;
    }
    cum += p;
    if (cum > peak) peak = cum;
    if (cum - peak < mdd) mdd = cum - peak;
  }

  const cost = fee + tax;
  const net = sellAmt - buyAmt - (afterCost ? cost : 0);
  const avgWin = wins > 0 ? winSum / wins : 0;
  const avgLoss = losses > 0 ? lossSum / losses : 0;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const rr = avgLoss < 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? 9.99 : 0;

  return {
    count: trades.length,
    buyAmt,
    sellAmt,
    fee,
    tax,
    cost,
    net,
    retPct: buyAmt > 0 ? (net / buyAmt) * 100 : 0,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    rr,
    swingCount,
    mdd,
  };
}

export function metricValueOf(pnlSum: number, buySum: number, count: number, metric: JournalMetric): number {
  if (metric === "pnl") return pnlSum;
  if (metric === "ret") return buySum > 0 ? (pnlSum / buySum) * 100 : 0;
  return count;
}

export interface TableGroupRow {
  readonly key: string;
  readonly anchorDay: string;
  readonly label: string;
  readonly summary: JournalSummary;
}

export function buildTableGroups(
  trades: readonly JournalTrade[],
  grain: JournalGrain,
  afterCost: boolean,
): readonly TableGroupRow[] {
  const map = new Map<string, { key: string; anchorDay: string; label: string; list: JournalTrade[] }>();
  for (const t of trades) {
    let key: string;
    let label: string;
    if (grain === "day") {
      key = t.exitDay;
      const [, m, d] = t.exitDay.split("-").map(Number);
      label = `${m}월 ${d}일 ${DOW_KO[dayOfWeek(t.exitDay)]}`;
    } else if (grain === "month") {
      key = t.exitDay.slice(0, 7);
      const [y, m] = key.split("-").map(Number);
      label = `${y}년 ${m}월`;
    } else if (grain === "year") {
      key = t.exitDay.slice(0, 4);
      label = `${key}년`;
    } else {
      key = t.code;
      label = t.name;
    }
    const existing = map.get(key);
    if (existing !== undefined) existing.list.push(t);
    else map.set(key, { key, anchorDay: t.exitDay, label, list: [t] });
  }
  const rows: TableGroupRow[] = [...map.values()].map((g) => ({
    key: g.key,
    anchorDay: g.anchorDay,
    label: g.label,
    summary: aggregateSummary(g.list, afterCost),
  }));
  rows.sort((a, b) => (grain === "sym" ? b.summary.net - a.summary.net : b.key.localeCompare(a.key)));
  return rows;
}

export interface CalendarCell {
  readonly day: string;
  readonly dayNum: number;
  readonly pnl: number;
  readonly count: number;
  readonly inRange: boolean;
}

export interface CalendarWeekRow {
  readonly cells: readonly (CalendarCell | null)[];
  readonly weekPnl: number;
  readonly weekCount: number;
}

export function buildCalendarWeeks(
  anchorDay: string,
  range: readonly [string, string],
  trades: readonly JournalTrade[],
  afterCost: boolean,
): { readonly year: number; readonly month: number; readonly weeks: readonly CalendarWeekRow[]; readonly maxAbs: number; readonly winDays: number; readonly lossDays: number } {
  const [yStr, mStr] = anchorDay.split("-");
  const year = Number(yStr) || 2026;
  const month = Number(mStr) || 11;
  const prefix = `${year}-${pad2(month)}-`;

  const byDay = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    if (!t.exitDay.startsWith(prefix)) continue;
    const cur = byDay.get(t.exitDay) ?? { pnl: 0, count: 0 };
    cur.pnl += tradePnl(t, afterCost);
    cur.count += 1;
    byDay.set(t.exitDay, cur);
  }

  const vals = [...byDay.values()];
  const maxAbs = Math.max(1, ...vals.map((x) => Math.abs(x.pnl)));
  const winDays = vals.filter((x) => x.pnl > 0).length;
  const lossDays = vals.filter((x) => x.pnl < 0).length;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rawWeeks: (CalendarCell | null)[][] = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = `${year}-${pad2(month)}-${pad2(d)}`;
    const dow = dayOfWeek(iso);
    if (dow < 1 || dow > 5) continue;
    if (rawWeeks.length === 0 || dow === 1) rawWeeks.push([null, null, null, null, null]);
    const info = byDay.get(iso);
    rawWeeks[rawWeeks.length - 1]![dow - 1] = {
      day: iso,
      dayNum: d,
      pnl: info?.pnl ?? 0,
      count: info?.count ?? 0,
      inRange: iso >= range[0] && iso <= range[1],
    };
  }

  const weeks: CalendarWeekRow[] = rawWeeks.map((cells) => {
    let weekPnl = 0;
    let weekCount = 0;
    for (const c of cells) {
      if (c !== null && c.count > 0) {
        weekPnl += c.pnl;
        weekCount += c.count;
      }
    }
    return { cells, weekPnl, weekCount };
  });

  return { year, month, weeks, maxAbs, winDays, lossDays };
}

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tickUnit(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

export function snapTick(price: number): number {
  const unit = tickUnit(price);
  return Math.max(unit, Math.round(price / unit) * unit);
}

const DEMO_SYMS: readonly [string, string, number, number, number][] = [
  ["012450", "한화에어로스페이스", 365000, 0.55, 2.8],
  ["196170", "알테오젠", 334000, 0.42, 2.6],
  ["267260", "HD현대일렉트릭", 358000, 0.5, 2.4],
  ["000660", "SK하이닉스", 192000, 0.22, 2.6],
  ["005930", "삼성전자", 59400, -0.18, 2.2],
  ["042700", "한미반도체", 112000, 0.12, 1.9],
  ["064350", "현대로템", 62400, 0.48, 2.0],
  ["247540", "에코프로비엠", 154000, -0.62, 2.0],
  ["003230", "삼양식품", 602000, 0.16, 1.5],
  ["034020", "두산에너빌리티", 22400, -0.25, 1.6],
];

export function generateDemoTrades(anchorToday: string): readonly JournalTrade[] {
  const tradingDays: string[] = [];
  const endMs = parseDayUtcMs(anchorToday);
  const startMs = endMs - 365 * 864e5;
  for (let ms = startMs; ms <= endMs; ms += 864e5) {
    const dow = new Date(ms).getUTCDay();
    if (dow >= 1 && dow <= 5) tradingDays.push(formatUtcMsToDay(ms));
  }
  const todayIdx = tradingDays.length - 1;
  if (todayIdx < 5) return [];

  const R = seededRng(2026112709);
  const pickW = (weights: readonly number[]): number => {
    let u = R() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i += 1) {
      u -= weights[i]!;
      if (u <= 0) return i;
    }
    return weights.length - 1;
  };
  const sessW = [0.05, 0.32, 0.15, 0.16, 0.11, 0.11, 0.04, 0.06];
  const sessBias = [0.65, 2.35, 1.3, 0.55, -0.95, -0.75, -0.2, -0.65];
  const sessRange: readonly [number, number][] = [
    [490, 528],
    [542, 567],
    [571, 597],
    [602, 684],
    [692, 800],
    [815, 910],
    [920, 926],
    [950, 1002],
  ];

  const trades: JournalTrade[] = [];
  const recentMonth = anchorToday.slice(0, 7);

  for (let di = 0; di <= todayIdx; di += 1) {
    const day = tradingDays[di]!;
    const isRecent = day.startsWith(recentMonth);
    const u = R();
    let count: number;
    if (di === todayIdx) count = 5;
    else if (di === todayIdx - 1) count = 3;
    else if (isRecent) count = u < 0.16 ? 0 : u < 0.45 ? 1 : u < 0.78 ? 2 : 3;
    else count = u < 0.65 ? 0 : u < 0.9 ? 1 : 2;

    const symWeights = DEMO_SYMS.map((s) => s[4]);
    for (let j = 0; j < count; j += 1) {
      const si = pickW(symWeights);
      symWeights[si] = 0;
      const sym = DEMO_SYMS[si]!;
      const sIdx = di === todayIdx && j === 0 ? 1 : di === todayIdx && j === 4 ? 7 : pickW(sessW);
      const venue: Venue = sIdx === 0 || sIdx === 7 ? "nxt" : "krx";
      const [loM, hiM] = sessRange[sIdx]!;
      const em = loM + Math.floor(R() * Math.max(1, hiM - loM));
      const swing = venue === "krx" && di < todayIdx - 1 && (R() < 0.18 || (di === todayIdx - 2 && j === 0));
      const d1Idx = swing ? Math.min(todayIdx, di + 1 + Math.floor(R() * 4)) : di;
      const exitDay = tradingDays[d1Idx]!;
      const xm = swing
        ? 548 + Math.floor(R() * 210)
        : sIdx === 0
          ? Math.min(538, em + 5 + Math.floor(R() * 18))
          : sIdx === 7
            ? Math.min(1018, em + 8 + Math.floor(R() * 30))
            : Math.min(929, em + 4 + Math.floor(R() * (R() < 0.55 ? 25 : 95)));

      const basePx = snapTick(sym[2] * (0.88 + R() * 0.24));
      const bias = (sessBias[sIdx]! + sym[3] + (swing ? 2.1 : 0)) / 100;
      const noise = (R() + R() - 1) * 0.028;
      const retMove = bias + noise;
      const exitPx = snapTick(basePx * (1 + retMove));
      const scaleBuy = R() < 0.34;
      const secondPx = snapTick(basePx * (1 + (retMove >= 0 ? 0.008 : -0.009)));
      const budget = (420 + Math.floor(R() * 980)) * 10000;
      const totalQty = Math.max(6, Math.round(budget / basePx));
      const q1 = scaleBuy ? Math.ceil(totalQty * 0.6) : totalQty;
      const q2 = totalQty - q1;

      const buys: JournalFill[] = [
        { side: "buy", day, minutes: em, timeLabel: formatMinutes(em), price: basePx, qty: q1, orderNo: `D${di}${j}B1`, fillAt: null },
        ...(scaleBuy && q2 > 0
          ? [{ side: "buy" as const, day, minutes: Math.min(xm - 1, em + 4), timeLabel: formatMinutes(Math.min(xm - 1, em + 4)), price: secondPx, qty: q2, orderNo: `D${di}${j}B2`, fillAt: null }]
          : []),
      ];
      const sells: JournalFill[] = [
        { side: "sell", day: exitDay, minutes: xm, timeLabel: formatMinutes(xm), price: exitPx, qty: totalQty, orderNo: `D${di}${j}S1`, fillAt: null },
      ];

      const buyAmt = buys.reduce((s, f) => s + f.price * f.qty, 0);
      const sellAmt = sells.reduce((s, f) => s + f.price * f.qty, 0);
      const fee = Math.floor((buyAmt + sellAmt) * FEE_RATE);
      const tax = Math.floor(sellAmt * TAX_RATE);
      const cost = fee + tax;
      const gross = sellAmt - buyAmt;
      const net = gross - cost;
      const avgBuy = buyAmt / totalQty;
      const avgSell = sellAmt / totalQty;
      const exitRet = (avgSell / avgBuy - 1) * 100;
      const mfe = Math.max(exitRet, 0) + R() * 1.4;
      const mae = Math.min(exitRet, 0) - R() * 1.1;
      const styleIdx: 0 | 1 | 2 = buys.length <= 1 ? 0 : buys[1]!.price >= buys[0]!.price ? 1 : 2;
      const holdDays = d1Idx - di;
      const holdMin = swing ? holdDays * 390 : Math.max(1, xm - em);
      const entrySlot = slotIdxOf(em, venue);
      const exitSlot = slotIdxOf(xm, venue);
      const tags: string[] = [];
      if (swing) tags.push("스윙");
      if (entrySlot === 1 && net > 0) tags.push("돌파매매");
      else if (entrySlot === 2 && net > 0) tags.push("눌림목");
      if (styleIdx === 2 && net < 0) tags.push("손절지연");
      else if (net < 0) tags.push("추격매수");
      if (net > 0 && styleIdx !== 2) tags.push("원칙준수");

      trades.push({
        id: `demo:${di}:${j}:${sym[0]}`,
        code: sym[0],
        name: sym[1],
        venue,
        entryDay: day,
        exitDay,
        entryMin: em,
        exitMin: xm,
        entryOrd: Math.floor(parseDayUtcMs(day) / 864e5) * 1440 + em,
        exitOrd: Math.floor(parseDayUtcMs(exitDay) / 864e5) * 1440 + xm,
        swing,
        holdDays,
        holdMin,
        holdBucket: holdBucketOf(swing, holdDays, holdMin),
        buys,
        sells,
        qty: totalQty,
        buyAmt,
        sellAmt,
        fee,
        tax,
        cost,
        gross,
        net,
        avgBuy,
        avgSell,
        mfe,
        mae,
        exitRet,
        styleIdx,
        entrySlot,
        exitSlot,
        fillSlots: [...new Set([entrySlot, exitSlot])],
        pairIdx: pairIdxOf(swing, venue, entrySlot, exitSlot),
        defaultTags: tags,
        defaultMemo: isRecent ? (swing ? "일봉 추세 지지 확인 후 스윙 진입" : net >= 0 ? "시초 수급 돌파 확인 후 청산" : "기준선 이탈 구간 정리") : "",
        demoSeed: Math.floor(R() * 4294967295),
      });
    }
  }

  return trades.sort((a, b) => a.exitOrd - b.exitOrd);
}

export function synthesizeDemoBars(trade: JournalTrade, tf: JournalTf): readonly JournalBar[] {
  const seed = trade.demoSeed ?? 1234567;
  const tfSalt = tf === "D" ? 911 : tf === "10" ? 1009 : tf === "5" ? 505 : tf === "3" ? 303 : 101;
  const r = seededRng(seed ^ tfSalt);
  const bars: JournalBar[] = [];
  const basePx = trade.buys[0]?.price ?? trade.avgBuy;
  const endPx = trade.sells[trade.sells.length - 1]?.price ?? trade.avgSell;

  if (tf === "D") {
    const preDays = 28;
    const spanDays = Math.max(1, trade.holdDays + 1);
    const postDays = 6;
    const total = preDays + spanDays + postDays;
    let curMs = parseDayUtcMs(trade.entryDay);
    const days: string[] = [];
    let back = preDays;
    while (back > 0) {
      curMs -= 864e5;
      const dow = new Date(curMs).getUTCDay();
      if (dow >= 1 && dow <= 5) {
        days.unshift(formatUtcMsToDay(curMs));
        back -= 1;
      }
    }
    curMs = parseDayUtcMs(trade.entryDay);
    days.push(trade.entryDay);
    let fwd = spanDays + postDays - 1;
    while (fwd > 0) {
      curMs += 864e5;
      const dow = new Date(curMs).getUTCDay();
      if (dow >= 1 && dow <= 5) {
        days.push(formatUtcMsToDay(curMs));
        fwd -= 1;
      }
    }

    const entryIdx = preDays;
    const exitIdx = Math.min(total - 1, preDays + Math.max(0, trade.holdDays));
    const scale = basePx * 0.015;
    let px = snapTick(basePx * (trade.net >= 0 ? 0.92 : 1.06));
    for (let i = 0; i < days.length; i += 1) {
      const target = i === entryIdx ? basePx : i === exitIdx ? endPx : null;
      const o = px;
      const drift = i < entryIdx ? (basePx - px) / Math.max(1, entryIdx - i) : i <= exitIdx ? (endPx - px) / Math.max(1, exitIdx - i + 1) : 0;
      const c = target ?? snapTick(o + drift + (r() - 0.5) * scale * 1.8);
      const h = snapTick(Math.max(o, c) + r() * scale * 0.9);
      const l = snapTick(Math.min(o, c) - r() * scale * 0.9);
      const day = days[i]!;
      bars.push({ t: Math.floor(parseDayUtcMs(day) / 1000) - 9 * 3600, o, h, l, c, v: Math.round(800 + r() * 2400), day, minutes: 540 });
      px = c;
    }
    return bars;
  }

  const step = tfStepMinutes(tf);
  const entryM = Math.floor(trade.entryMin / step) * step;
  const exitM = Math.max(entryM + step, Math.floor((trade.swing ? trade.entryMin + step * 16 : trade.exitMin) / step) * step);
  const preCount = 18;
  const holdCount = Math.max(4, Math.min(60, Math.round((exitM - entryM) / step)));
  const postCount = 14;
  const total = preCount + holdCount + postCount;
  const startM = Math.max(480, entryM - preCount * step);
  const scale = basePx * 0.0024 * Math.sqrt(step);
  let px = snapTick(basePx + (trade.net >= 0 ? -scale * 2 : scale * 2));
  const dayMs = parseDayUtcMs(trade.exitDay);

  for (let i = 0; i < total; i += 1) {
    const m = startM + i * step;
    const isEntry = i === preCount;
    const isExit = i === preCount + holdCount;
    const o = px;
    const drift = i < preCount ? (basePx - px) / Math.max(1, preCount - i) : i <= preCount + holdCount ? (endPx - px) / Math.max(1, preCount + holdCount - i + 1) : 0;
    const c = isEntry ? basePx : isExit ? endPx : snapTick(o + drift + (r() - 0.5) * scale * 2);
    const h = snapTick(Math.max(o, c) + r() * scale * 0.9);
    const l = snapTick(Math.min(o, c) - r() * scale * 0.9);
    bars.push({
      t: Math.floor(dayMs / 1000) + m * 60 - 9 * 3600,
      o,
      h,
      l,
      c,
      v: Math.round(120 + r() * 680 * (isEntry || isExit ? 2.2 : 1)),
      day: trade.exitDay,
      minutes: m,
    });
    px = c;
  }
  return bars;
}
