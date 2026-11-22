import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolDaySummary } from "../../api/generated/SymbolDaySummary";
import { direction, formatChange, formatDecimal, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { LadderRow } from "./ladder";

export interface QuoteInfo {
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | "warning" | null;
  readonly band?: true;
}

export type InfoLine =
  | { readonly kind: "item"; readonly item: QuoteInfo }
  | { readonly kind: "range"; readonly label: string; readonly position: number | null }
  | { readonly kind: "ends"; readonly low: string; readonly high: string };

export type InfoPage = 0 | 1;
export const INFO_TABS: readonly { readonly page: InfoPage; readonly label: string }[] = [{ page: 0, label: "시세" }, { page: 1, label: "종목" }];
export const otherInfoPage = (page: InfoPage): InfoPage => (page === 0 ? 1 : 0);

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

const rangePosition = (price: number | null, low: number, high: number): number | null => {
  if (price === null) return null;
  if (high === low) return 0.5;
  return Math.min(1, Math.max(0, (price - low) / (high - low)));
};

const item = (value: QuoteInfo): InfoLine => ({ kind: "item", item: value });

export function quoteInfoItems(page: InfoPage, { price, previousClose, summary, fundamentals }: QuoteInfoInput): InfoLine[] {
  const base = previousClose !== null && previousClose > 0 ? previousClose : null;
  const against = (value: number | null | undefined): "up" | "down" | null => {
    if (value == null || base === null) return null;
    const side = direction(value - base);
    return side === "flat" ? null : side;
  };
  const priced = (label: string, value: number | null | undefined): InfoLine => item({ label, value: orDash(value, won), tone: against(value) });
  const plain = (label: string, value: string): InfoLine => item({ label, value, tone: null });
  const rangeLines = (label: string, low: number | null | undefined, high: number | null | undefined, ends: boolean): InfoLine[] => {
    if (low == null || high == null || high < low) return ends ? [plain(label, "-")] : [];
    const range: InfoLine = { kind: "range", label, position: rangePosition(price, low, high) };
    return ends ? [range, { kind: "ends", low: won(low), high: won(high) }] : [range];
  };
  if (page === 1) {
    return [
      priced("상한가", fundamentals?.upperLimit),
      priced("하한가", fundamentals?.lowerLimit),
      ...rangeLines("52주 범위", fundamentals?.low52w, fundamentals?.high52w, true),
      plain("시가총액", orDash(fundamentals?.marketCap, formatKoreanWon)),
      plain("PER·PBR", fundamentals?.per == null && fundamentals?.pbr == null ? "-" : `${orDash(fundamentals?.per, formatDecimal)}·${orDash(fundamentals?.pbr, formatDecimal)}`),
      plain("외국인소진율", orDash(fundamentals?.foreignExhaustionRate, (value) => `${formatDecimal(value)}%`)),
    ];
  }
  const change = price !== null && base !== null ? price - base : null;
  const rate = change !== null && base !== null ? (change / base) * 100 : null;
  const changeTone = against(price);
  return [
    priced("시가", summary?.open),
    priced("고가", summary?.high),
    priced("저가", summary?.low),
    ...rangeLines("당일 범위", summary?.low, summary?.high, false),
    plain("기준가", orDash(previousClose, won)),
    item({ label: "전일대비", value: change === null || rate === null ? "-" : `${formatChange(change, false)} ${formatPercent(rate)}`, tone: changeTone, ...(changeTone === null ? {} : { band: true as const }) }),
    plain("거래량", orDash(summary?.volume, formatVolume)),
    plain("거래대금", orDash(summary?.tradeValueWon, formatKoreanWon)),
  ];
}

export interface ExpectedFillInput {
  readonly price: number;
  readonly qty: number;
}

export const INFO_CARD_ROWS = 9;
const EXPECTED_LINES = 2;

export function expectedInfoItems(expected: ExpectedFillInput): QuoteInfo[] {
  return [
    { label: "예상체결가", value: won(expected.price), tone: "warning" },
    { label: "예상체결량", value: formatPrice(expected.qty, false), tone: "warning" },
  ];
}

export function infoCardRows(rows: readonly LadderRow[]): number {
  const crossed = rows.slice(0, INFO_CARD_ROWS).findIndex((row) => row.bid != null);
  return crossed < 0 ? Math.min(INFO_CARD_ROWS, rows.length) : crossed;
}

export function expectedItemsOnPage(page: InfoPage, expected: ExpectedFillInput | null): QuoteInfo[] {
  return page === 0 && expected !== null ? expectedInfoItems(expected) : [];
}

export function placeInfoItems(rows: readonly LadderRow[], body: readonly InfoLine[], expectedItems: readonly QuoteInfo[]): InfoLine[] {
  const capacity = infoCardRows(rows) - 1;
  if (capacity <= 0) return [];
  if (expectedItems.length === 0 || capacity < EXPECTED_LINES) return body.slice(0, capacity);
  return [...body.slice(0, capacity - EXPECTED_LINES), ...expectedItems.map(item)];
}
