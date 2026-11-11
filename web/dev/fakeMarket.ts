// 가짜 API의 시세와 검색(dev·테스트 전용, 빌드에 들어가지 않는다).
// 봉은 종목코드를 씨앗으로 한 결정론적 무작위 걸음이다. 통합 일봉은 오늘 종가가 fixtures의 close와 같게 뒤에서 앞으로 만든다.
// KRX·NXT 일봉은 통합 일봉을 거래소마다 조금씩 흔든 것이고, 분봉은 그 거래소 일봉의 시가에서 종가로 잇는 걸음이다.
import type { Bar } from "../src/api/generated/Bar.ts";
import type { BarsPage } from "../src/api/generated/BarsPage.ts";
import type { Period } from "../src/api/generated/Period.ts";
import type { Quote } from "../src/api/generated/Quote.ts";
import type { SymbolInfo } from "../src/api/generated/SymbolInfo.ts";
import type { Venue } from "../src/api/generated/Venue.ts";
import fixture from "./fixtures/symbols.json" with { type: "json" };

interface FakeSymbol extends SymbolInfo {
  close: number;
  volume: number;
  years: number;
  fail?: string;
}

export const SYMBOLS: FakeSymbol[] = fixture.symbols as FakeSymbol[];
export const publicInfo = ({ code, name, kind, market, nxtEnabled }: FakeSymbol): SymbolInfo => ({ code, name, kind, market, nxtEnabled });
export const findSymbol = (code: string) => SYMBOLS.find((s) => s.code === code);

// ---- 무작위 ----
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedOf(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r());

// KRX 호가 단위(2023년 개편). ETF·리츠 ETF는 5원.
function tick(p: number, s: FakeSymbol) {
  if (s.kind === "etf") return 5;
  return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
}
function roundPrice(p: number, s: FakeSymbol) {
  if (s.kind === "index") return Math.round(p * 100) / 100;
  const k = tick(p, s);
  return Math.max(k, Math.round(p / k) * k);
}

// ---- 달력(KST 날짜를 UTC 자정으로 다룬다) ----
const DAY = 86400;
const KST = 32400;
/** KST 날짜(UTC 자정 초) → 봉 시작 t(그 날 00:00 KST의 Unix 초). */
const kstMidnight = (utcDay: number) => utcDay - KST;
function todayUtcDay(nowMs: number) {
  const kst = Math.floor(nowMs / 1000) + KST;
  return kst - (kst % DAY);
}
const isWeekday = (utcDay: number) => {
  const w = new Date(utcDay * 1000).getUTCDay();
  return w !== 0 && w !== 6;
};

/** 오늘(주말이면 그 직전 평일)까지 n 평일. */
function tradingDays(n: number, nowMs: number): number[] {
  const out: number[] = [];
  let d = todayUtcDay(nowMs);
  while (out.length < n) {
    if (isWeekday(d)) out.push(d);
    d -= DAY;
  }
  return out.reverse();
}

function dailyBars(s: FakeSymbol, nowMs: number): Bar[] {
  const r = mulberry32(seedOf(s.code));
  const days = tradingDays(Math.round(s.years * 250), nowMs);
  const sigma = s.kind === "index" ? 0.009 : 0.018;
  const drift = s.kind === "index" ? 0.0004 : 0.0006;
  const closes = new Array<number>(days.length);
  closes[days.length - 1] = s.close;
  for (let i = days.length - 1; i > 0; i--) {
    const ret = drift + sigma * gauss(r) + 0.004 * Math.sin(i / 37);
    closes[i - 1] = Math.max(s.close * 0.04, closes[i]! / Math.exp(ret));
  }
  return days.map((d, i) => {
    const c = closes[i]!;
    const prev = closes[i - 1] ?? c;
    const o = prev * Math.exp(sigma * 0.35 * gauss(r));
    const h = Math.max(o, c) * Math.exp(Math.abs(gauss(r)) * sigma * 0.5);
    const l = Math.min(o, c) / Math.exp(Math.abs(gauss(r)) * sigma * 0.5);
    const move = Math.abs(Math.log(c / prev)) / sigma;
    const v = Math.round(s.volume * Math.exp(0.35 * gauss(r)) * (0.7 + 0.35 * move));
    const close = i === days.length - 1 ? s.close : roundPrice(c, s);
    const open = roundPrice(o, s);
    return {
      t: kstMidnight(d),
      o: open,
      h: Math.max(roundPrice(h, s), open, close),
      l: Math.min(roundPrice(l, s), open, close),
      c: close,
      v,
    };
  });
}

/** 봉 시작 KST 날짜: 주봉은 그 주 월요일, 월봉은 그 달 1일(주말이어도). */
function bucketStart(t: number, period: "W" | "M" | "Q" | "Y"): number {
  const day = t + KST;
  const d = new Date(day * 1000);
  if (period === "W") return kstMidnight(day - ((d.getUTCDay() + 6) % 7) * DAY);
  const months = period === "Y" ? 12 : period === "Q" ? 3 : 1;
  return kstMidnight(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / months) * months, 1) / 1000);
}

function aggregate(daily: Bar[], period: "W" | "M" | "Q" | "Y"): Bar[] {
  const out: Bar[] = [];
  for (const b of daily) {
    const t = bucketStart(b.t, period);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else out.push({ ...b, t });
  }
  return out;
}

// ---- 거래소 ----
/** NXT 시세는 2025-03-04에 시작했다(ADR 0007). */
const NXT_START = kstMidnight(Date.UTC(2025, 2, 4) / 1000);
const VENUE_VOLUME_SHARE: Record<Exclude<Venue, "combined">, number> = { krx: 0.8, nxt: 0.2 };

/** 거래소 일봉: 통합 일봉의 가격을 봉마다 거래소마다 다르게 조금 흔든다. */
function venueDaily(base: Bar[], s: FakeSymbol, venue: Exclude<Venue, "combined">): Bar[] {
  const bars = venue === "nxt" ? base.filter((b) => b.t >= NXT_START) : base;
  return bars.map((b) => {
    const r = mulberry32(seedOf(`${s.code}/${venue}/${b.t}`));
    const jiggle = (p: number) => roundPrice(p * Math.exp(0.004 * gauss(r)), s);
    const o = jiggle(b.o);
    const c = jiggle(b.c);
    return {
      t: b.t,
      o,
      h: Math.max(jiggle(b.h), o, c),
      l: Math.min(jiggle(b.l), o, c),
      c,
      v: Math.round(b.v * VENUE_VOLUME_SHARE[venue] * Math.exp(0.2 * gauss(r))),
    };
  });
}

// ---- 분봉 ----
const MINUTE = 60;
/** 분봉은 최근 1년만 있다(U1). */
const INTRADAY_DAYS = 365;
/** 거래 시간(KST 분). KRX와 지수는 정규장, NXT와 통합은 프리·애프터마켓을 포함한다. */
function session(venue: Venue | null): { open: number; close: number } {
  return venue === "nxt" || venue === "combined" ? { open: 8 * 60, close: 20 * 60 } : { open: 9 * 60, close: 15 * 60 + 30 };
}
const PERIOD_MINUTES: Record<Exclude<Period, "D" | "W" | "M" | "Q" | "Y">, number> = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60 };

/** 1분봉: 그날 일봉의 시가에서 종가로 가는 브라운 다리. 오늘은 지금까지만. */
function minuteBars(daily: Bar[], s: FakeSymbol, venue: Venue | null, nowMs: number): Bar[] {
  const nowS = Math.floor(nowMs / 1000);
  const from = nowS - INTRADAY_DAYS * DAY;
  const { open, close } = session(venue);
  const n = close - open;
  const sigma = (s.kind === "index" ? 0.009 : 0.018) / Math.sqrt(n);
  const out: Bar[] = [];
  for (const d of daily) {
    if (d.t < from) continue;
    const r = mulberry32(seedOf(`${s.code}/${venue}/m/${d.t}`));
    const walk = [0];
    for (let i = 1; i <= n; i++) walk.push(walk[i - 1]! + sigma * gauss(r));
    const end = walk[n]!;
    const logO = Math.log(d.o);
    const logC = Math.log(d.c);
    let prev = d.o;
    for (let i = 0; i < n; i++) {
      const t = d.t + (open + i) * MINUTE;
      if (t > nowS) break;
      const k = (i + 1) / n;
      const c = roundPrice(Math.exp(logO + (logC - logO) * k + walk[i + 1]! - k * end), s);
      const o = prev;
      const wick = () => Math.exp(Math.abs(gauss(r)) * sigma * 0.6);
      const smile = 0.5 + 1.5 * ((2 * i) / n - 1) ** 2;
      out.push({
        t,
        o,
        h: Math.max(roundPrice(Math.max(o, c) * wick(), s), o, c),
        l: Math.min(roundPrice(Math.min(o, c) / wick(), s), o, c),
        c,
        v: Math.max(1, Math.round((d.v / n) * smile * Math.exp(0.4 * gauss(r)))),
      });
      prev = c;
    }
  }
  return out;
}

/** n분봉은 KST 시각이 n분의 배수인 곳에서 시작한다. */
function aggregateMinutes(minutes: Bar[], n: number): Bar[] {
  if (n === 1) return minutes;
  const out: Bar[] = [];
  for (const b of minutes) {
    const kst = b.t + KST;
    const t = b.t - (kst % (n * MINUTE));
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else out.push({ ...b, t });
  }
  return out;
}

const cache = new Map<string, { minute: number; bars: Bar[] }>();
/** 분봉은 오늘 지금까지만 있으므로 분이 바뀌면 새로 만든다. */
function cached(key: string, nowMs: number, make: () => Bar[]): Bar[] {
  const minute = Math.floor(nowMs / 60000);
  const hit = cache.get(key);
  if (hit?.minute === minute) return hit.bars;
  const bars = make();
  cache.set(key, { minute, bars });
  return bars;
}

/** 마지막 원소가 진행 중 구간(current)이다. 지수는 venue가 null, 주식은 셋 중 하나다. */
export function seriesOf(s: FakeSymbol, venue: Venue | null, period: Period, nowMs: number): Bar[] {
  return cached(`${s.code}/${venue}/${period}`, nowMs, () => {
    if (period === "D") {
      const base = cached(`${s.code}/base`, nowMs, () => dailyBars(s, nowMs));
      return venue === null || venue === "combined" ? base : venueDaily(base, s, venue);
    }
    if (period === "W" || period === "M" || period === "Q" || period === "Y") return aggregate(seriesOf(s, venue, "D", nowMs), period);
    if (period === "1m") return minuteBars(seriesOf(s, venue, "D", nowMs), s, venue, nowMs);
    return aggregateMinutes(seriesOf(s, venue, "1m", nowMs), PERIOD_MINUTES[period]);
  });
}

function countBefore(bars: Bar[], before: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < before) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const VENUES: readonly Venue[] = ["combined", "krx", "nxt"];
const isVenue = (x: string): x is Venue => (VENUES as readonly string[]).includes(x);

/**
 * `/api/bars?venue=`의 규칙(계약 003c532): 주식은 없으면 통합, 지수에 주면 400,
 * NXT 불가 종목에 nxt면 400. 오류면 사람이 읽는 문장을 돌려준다.
 */
export function resolveVenue(s: FakeSymbol, param: string | null): { venue: Venue | null } | { error: string } {
  if (param !== null && !isVenue(param)) return { error: `거래소는 combined, krx, nxt 중 하나입니다: ${param}` };
  const wanted = param;
  if (s.kind === "index") return wanted === null ? { venue: null } : { error: "지수에는 거래소가 없습니다" };
  if (wanted === "nxt" && !s.nxtEnabled) return { error: `NXT에서 거래되지 않는 종목입니다: ${s.name}(${s.code})` };
  return { venue: wanted ?? "combined" };
}

export function barsPage(
  s: FakeSymbol,
  venue: Venue | null,
  period: Period,
  limit: number,
  before: number | null,
  nowMs: number,
): BarsPage {
  const all = seriesOf(s, venue, period, nowMs);
  const confirmedEnd = Math.max(0, all.length - 1);
  const end = before === null ? confirmedEnd : Math.min(confirmedEnd, countBefore(all, before));
  const start = Math.max(0, end - limit);
  const bars = all.slice(start, end);
  const first = bars[0];
  return {
    symbol: s.code,
    venue,
    period,
    bars,
    current: before === null ? (all[all.length - 1] ?? null) : null,
    nextBefore: first && start > 0 ? first.t : null,
    seq: null,
  };
}

// ---- 검색(서버 규칙의 대역, backend.md §8.2) ----
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const isSyllable = (c: string) => c >= "가" && c <= "힣";
const choseongOf = (name: string) =>
  [...name].map((c) => (isSyllable(c) ? CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)] : c)).join("");
export const normalize = (q: string) => q.trim().replace(/\s+/g, "").toUpperCase();
const KIND_ORDER = ["index", "common", "preferred", "etf", "reit"];
const charClass = (c: string) => (isSyllable(c) ? 0 : /[A-Z]/i.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);
function compareNames(a: string, b: string) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!, q = y[i]!;
    if (p === q) continue;
    return charClass(p) - charClass(q) || (p < q ? -1 : 1);
  }
  return x.length - y.length;
}

export function search(raw: string): SymbolInfo[] {
  const q = normalize(raw);
  if (!q) return [];
  const jamoOnly = [...q].every((c) => CHO.includes(c));
  const rank = (s: FakeSymbol): number | null => {
    const name = normalize(s.name);
    const code = s.code.replace(/^IDX:/, "");
    if (code === q || s.code === q) return 0;
    if (name === q) return 1;
    if (code.startsWith(q)) return 2;
    if (name.startsWith(q)) return 3;
    const cho = jamoOnly ? choseongOf(name) : "";
    if (jamoOnly && cho.startsWith(q)) return 4;
    if (name.includes(q)) return 5;
    if (jamoOnly && cho.includes(q)) return 6;
    return null;
  };
  return SYMBOLS.map((s) => ({ s, r: rank(s) }))
    .filter((x): x is { s: FakeSymbol; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || KIND_ORDER.indexOf(a.s.kind) - KIND_ORDER.indexOf(b.s.kind) || compareNames(a.s.name, b.s.name))
    .slice(0, 20)
    .map((x) => publicInfo(x.s));
}

export function quoteOf(s: FakeSymbol, nowMs: number): Quote | null {
  if (s.fail === "unknown_symbol") return null;
  const bars = seriesOf(s, s.kind === "index" ? null : "combined", "D", nowMs);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last || !prev) return null;
  const change = last.c - prev.c;
  return {
    symbol: s.code,
    price: last.c,
    change: s.kind === "index" ? Math.round(change * 100) / 100 : change,
    changeRate: Math.round((change / prev.c) * 10000) / 100,
    volume: last.v,
    t: Math.floor(nowMs / 1000),
    source: "polled",
  };
}
