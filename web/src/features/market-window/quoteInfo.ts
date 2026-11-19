import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolDaySummary } from "../../api/generated/SymbolDaySummary";
import { direction, formatChange, formatDecimal, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { LadderRow } from "./ladder";

export interface QuoteInfo {
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | null;
}

export type InfoPage = 0 | 1;
export const INFO_PAGES: readonly InfoPage[] = [0, 1];
export const nextInfoPage = (page: InfoPage): InfoPage => (page === 0 ? 1 : 0);

export interface QuoteInfoInput {
  readonly price: number | null;
  readonly previousClose: number | null;
  readonly summary: Pick<SymbolDaySummary, "open" | "high" | "low" | "volume" | "tradeValueWon"> | null;
  readonly fundamentals: Pick<Fundamentals, "upperLimit" | "lowerLimit" | "high52w" | "low52w" | "marketCap" | "per" | "pbr" | "foreignExhaustionRate"> | null;
}

const orDash = (value: number | null | undefined, format: (value: number) => string): string => (value == null ? "-" : format(value));
const won = (price: number): string => formatPrice(price, false);

const WON_PER_MAN = 1e4;
const WON_PER_EOK = 1e8;
const WON_PER_JO = 1e12;
const grouped = (value: number): string => Math.floor(value).toLocaleString("ko-KR");

export function formatKoreanWon(amount: number): string {
  if (amount >= WON_PER_JO) {
    const eok = Math.floor((amount % WON_PER_JO) / WON_PER_EOK);
    return eok === 0 ? `${grouped(amount / WON_PER_JO)}조` : `${grouped(amount / WON_PER_JO)}조 ${grouped(eok)}억`;
  }
  if (amount >= WON_PER_EOK) return `${grouped(amount / WON_PER_EOK)}억`;
  if (amount >= WON_PER_MAN) return `${grouped(amount / WON_PER_MAN)}만`;
  return `${grouped(amount)}원`;
}

export function quoteInfoItems(page: InfoPage, { price, previousClose, summary, fundamentals }: QuoteInfoInput): QuoteInfo[] {
  const base = previousClose !== null && previousClose > 0 ? previousClose : null;
  const against = (value: number | null | undefined): QuoteInfo["tone"] => {
    if (value == null || base === null) return null;
    const side = direction(value - base);
    return side === "flat" ? null : side;
  };
  const priced = (label: string, value: number | null | undefined): QuoteInfo => ({ label, value: orDash(value, won), tone: against(value) });
  const plain = (label: string, value: string): QuoteInfo => ({ label, value, tone: null });
  if (page === 1) {
    return [
      priced("상한가", fundamentals?.upperLimit),
      priced("하한가", fundamentals?.lowerLimit),
      plain("52주 최고", orDash(fundamentals?.high52w, won)),
      plain("52주 최저", orDash(fundamentals?.low52w, won)),
      plain("시가총액", orDash(fundamentals?.marketCap, formatKoreanWon)),
      plain("PER", orDash(fundamentals?.per, (value) => `${formatDecimal(value)}배`)),
      plain("PBR", orDash(fundamentals?.pbr, (value) => `${formatDecimal(value)}배`)),
      plain("외국인소진율", orDash(fundamentals?.foreignExhaustionRate, (value) => `${formatDecimal(value)}%`)),
    ];
  }
  const change = price !== null && base !== null ? price - base : null;
  const rate = change !== null && base !== null ? (change / base) * 100 : null;
  return [
    priced("시가", summary?.open),
    priced("고가", summary?.high),
    priced("저가", summary?.low),
    plain("기준가", orDash(previousClose, won)),
    { label: "전일대비", value: change === null || rate === null ? "-" : `${formatChange(change, false)} ${formatPercent(rate)}`, tone: against(price) },
    plain("거래량", orDash(summary?.volume, formatVolume)),
    plain("거래대금", orDash(summary?.tradeValueWon, formatKoreanWon)),
  ];
}

export interface ExpectedFillInput {
  readonly price: number;
  readonly qty: number;
}

export const INFO_SLOT_ROWS = 9;
const FIRST_FREE_SLOT = 7;
const SHIFTED_FIRST_SLOT = 5;

export function expectedInfoItems(expected: ExpectedFillInput, previousClose: number | null): QuoteInfo[] {
  const side = previousClose === null || !(previousClose > 0) ? "flat" : direction(expected.price - previousClose);
  return [
    { label: "예상체결가", value: won(expected.price), tone: side === "flat" ? null : side },
    { label: "예상체결량", value: formatPrice(expected.qty, false), tone: null },
  ];
}

export const firstShownInfoSlot = (rows: readonly LadderRow[], slots: readonly (QuoteInfo | null)[]): number =>
  slots.findIndex((item, slot) => item !== null && rows[slot]?.bid == null);

export function expectedItemsOnPage(page: InfoPage, expected: ExpectedFillInput | null, previousClose: number | null): QuoteInfo[] {
  return page === 0 && expected !== null ? expectedInfoItems(expected, previousClose) : [];
}

export function placeInfoItems(rows: readonly LadderRow[], items: readonly QuoteInfo[], expectedItems: readonly QuoteInfo[]): (QuoteInfo | null)[] {
  const taken = (slot: number): boolean => rows[slot]?.bid != null;
  const slots: (QuoteInfo | null)[] = Array.from({ length: INFO_SLOT_ROWS }, () => null);
  if (expectedItems.length === 0) {
    items.forEach((item, slot) => { slots[slot] = item; });
    return slots;
  }
  const freeBelow = !taken(FIRST_FREE_SLOT) && !taken(FIRST_FREE_SLOT + 1);
  const firstExpected = freeBelow ? FIRST_FREE_SLOT : SHIFTED_FIRST_SLOT;
  items.slice(0, firstExpected).forEach((item, slot) => { slots[slot] = item; });
  expectedItems.forEach((item, offset) => { if (!taken(firstExpected + offset)) slots[firstExpected + offset] = item; });
  return slots;
}
