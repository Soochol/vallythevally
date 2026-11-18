import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { LadderRow } from "./ladder";

export interface QuoteInfo {
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | null;
}

export interface QuoteInfoInput {
  readonly price: number | null;
  readonly previousClose: number | null;
  readonly volume: number | null;
  readonly upperLimit: number | null;
  readonly lowerLimit: number | null;
}

const orDash = (value: number | null, format: (value: number) => string): string => (value === null ? "-" : format(value));
const won = (price: number): string => formatPrice(price, false);

export function quoteInfoItems({ price, previousClose, volume, upperLimit, lowerLimit }: QuoteInfoInput): QuoteInfo[] {
  const change = price !== null && previousClose !== null ? price - previousClose : null;
  const rate = change !== null && previousClose !== null && previousClose > 0 ? (change / previousClose) * 100 : null;
  const tone = change === null || change === 0 ? null : change > 0 ? "up" : "down";
  return [
    { label: "현재가", value: orDash(price, won), tone },
    { label: "전일대비", value: orDash(change, (value) => formatChange(value, false)), tone },
    { label: "등락률", value: orDash(rate, formatPercent), tone },
    { label: "거래량", value: orDash(volume, formatVolume), tone: null },
    { label: "기준가", value: orDash(previousClose, won), tone: null },
    { label: "상한가", value: orDash(upperLimit, won), tone: null },
    { label: "하한가", value: orDash(lowerLimit, won), tone: null },
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
