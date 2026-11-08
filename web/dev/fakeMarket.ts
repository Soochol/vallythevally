// 가짜 API의 시세와 검색(dev·테스트 전용, 빌드에 들어가지 않는다).
// 봉은 종목코드를 씨앗으로 한 결정론적 무작위 걸음이다. 오늘 봉의 종가가 fixtures의 close와 같게 뒤에서 앞으로 만든다.
import type { Bar } from "../src/api/generated/Bar.ts";
import type { BarsPage } from "../src/api/generated/BarsPage.ts";
import type { Period } from "../src/api/generated/Period.ts";
import type { SymbolInfo } from "../src/api/generated/SymbolInfo.ts";
import fixture from "./fixtures/symbols.json" with { type: "json" };

interface FakeSymbol extends SymbolInfo {
  close: number;
  volume: number;
  years: number;
  fail?: string;
}

export const SYMBOLS: FakeSymbol[] = fixture.symbols as FakeSymbol[];
const PUBLIC_KEYS = ["code", "name", "kind", "market"] as const;
export const publicInfo = (s: FakeSymbol): SymbolInfo =>
  Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]])) as unknown as SymbolInfo;
export const findSymbol = (code: string) => SYMBOLS.find((s) => s.code === code);

// ---- 무작위 ----
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(s: string) {
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
function bucketStart(t: number, period: "W" | "M"): number {
  const day = t + KST;
  const d = new Date(day * 1000);
  if (period === "W") return kstMidnight(day - ((d.getUTCDay() + 6) % 7) * DAY);
  return kstMidnight(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function aggregate(daily: Bar[], period: "W" | "M"): Bar[] {
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

const cache = new Map<string, Bar[]>();
/** 마지막 원소가 진행 중 구간(current)이다. */
export function seriesOf(s: FakeSymbol, period: Period, nowMs: number): Bar[] {
  const key = `${s.code}/${period}/${todayUtcDay(nowMs)}`;
  let bars = cache.get(key);
  if (!bars) {
    const daily = dailyBars(s, nowMs);
    bars = period === "D" ? daily : period === "W" || period === "M" ? aggregate(daily, period) : [];
    cache.set(key, bars);
  }
  return bars;
}

export function barsPage(s: FakeSymbol, period: Period, limit: number, before: number | null, nowMs: number): BarsPage {
  const all = seriesOf(s, period, nowMs);
  const confirmed = all.slice(0, -1);
  const pool = before === null ? confirmed : confirmed.filter((b) => b.t < before);
  const bars = pool.slice(Math.max(0, pool.length - limit));
  const first = bars[0];
  return {
    symbol: s.code,
    period,
    bars,
    current: before === null ? (all[all.length - 1] ?? null) : null,
    nextBefore: first && pool.length > bars.length ? first.t : null,
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
