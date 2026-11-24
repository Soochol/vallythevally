import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolDaySummary } from "../../api/generated/SymbolDaySummary";
import type { ViDirection } from "../../api/generated/ViDirection";
import { direction, formatDecimal, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { LadderRow } from "./ladder";

export type InfoKey =
  | "open"
  | "high"
  | "low"
  | "base"
  | "volume"
  | "value"
  | "expectedPrice"
  | "upper"
  | "lower"
  | "cap";

export const DAY_PRICE_KEYS: readonly InfoKey[] = ["open", "high", "low"];

export function toggleInfoKey(flipped: ReadonlySet<InfoKey>, key: InfoKey): ReadonlySet<InfoKey> {
  const next = new Set(flipped);
  const targets: readonly InfoKey[] = DAY_PRICE_KEYS.includes(key) ? DAY_PRICE_KEYS : [key];
  const remove = flipped.has(key);
  for (const target of targets) {
    if (remove) next.delete(target);
    else next.add(target);
  }
  return next;
}

export interface QuoteInfo {
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | "warning" | null;
}

export interface InfoLine {
  readonly kind: "item";
  readonly key?: InfoKey;
  readonly flipped?: true;
  readonly item: QuoteInfo;
}

export type InfoPage = 0 | 1;
export const INFO_TABS: readonly { readonly page: InfoPage; readonly label: string }[] = [{ page: 0, label: "시세" }, { page: 1, label: "종목" }];
export const otherInfoPage = (page: InfoPage): InfoPage => (page === 0 ? 1 : 0);

export type QuoteFundamentals =
  Pick<Fundamentals, "upperLimit" | "lowerLimit" | "marketCap">
  & Partial<Pick<Fundamentals, "listedShares">>;

export interface ViInfo {
  readonly up: number | null;
  readonly down: number | null;
  readonly triggered: { readonly direction: ViDirection; readonly price: number | null } | null;
}

export interface QuoteInfoInput {
  readonly price: number | null;
  readonly previousClose: number | null;
  readonly summary: Pick<SymbolDaySummary, "open" | "high" | "low" | "volume" | "tradeValueWon"> | null;
  readonly fundamentals: QuoteFundamentals | null;
  readonly sameTimeRatio?: number | null;
  readonly vi?: ViInfo | null;
}

const orDash = (value: number | null | undefined, format: (value: number) => string): string => (value == null ? "-" : format(value));
const won = (price: number): string => formatPrice(price, false);
const decimalPercent = (value: number): string => `${formatDecimal(value)}%`;
const positiveBase = (value: number | null | undefined): number | null => (value != null && value > 0 ? value : null);
const rateOf = (value: number | null | undefined, ref: number | null): number | null => (value == null || ref === null ? null : ((value - ref) / ref) * 100);
const rateTone = (rate: number | null): "up" | "down" | null => {
  if (rate === null) return null;
  const side = direction(rate);
  return side === "flat" ? null : side;
};

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

const itemLine = (value: QuoteInfo, key?: InfoKey, flipped?: boolean): InfoLine => ({
  kind: "item",
  ...(key === undefined ? {} : { key }),
  ...(flipped ? { flipped: true as const } : {}),
  item: value,
});

export function quoteInfoItems(page: InfoPage, { price, previousClose, summary, fundamentals, sameTimeRatio, vi }: QuoteInfoInput, flipped?: ReadonlySet<InfoKey>): InfoLine[] {
  const base = positiveBase(previousClose);
  const current = positiveBase(price);
  const isFlipped = (key: InfoKey): boolean => flipped?.has(key) ?? false;
  const against = (value: number | null | undefined): "up" | "down" | null => {
    if (value == null || base === null) return null;
    const side = direction(value - base);
    return side === "flat" ? null : side;
  };
  const priced = (key: InfoKey, label: string, value: number | null | undefined): InfoLine =>
    itemLine({ label, value: orDash(value, won), tone: against(value) }, key);
  const plain = (key: InfoKey, label: string, value: string, on?: boolean): InfoLine =>
    itemLine({ label, value, tone: null }, key, on);
  const signedRate = (key: InfoKey, label: string, value: number | null | undefined, ref: number | null): InfoLine => {
    const rate = rateOf(value, ref);
    return itemLine({ label, value: orDash(rate, formatPercent), tone: rateTone(rate) }, key, true);
  };
  const priceOrRate = (key: InfoKey, label: string, flippedLabel: string, value: number | null | undefined, ref: number | null): InfoLine =>
    isFlipped(key) ? signedRate(key, flippedLabel, value, ref) : priced(key, label, value);
  if (page === 1) {
    const viLine = (side: ViDirection, label: string, triggeredLabel: string, computed: number | null): InfoLine => {
      const firing = vi?.triggered?.direction === side;
      const value = firing ? (vi.triggered?.price ?? computed) : computed;
      return itemLine({
        label: firing ? triggeredLabel : label,
        value: orDash(value, won),
        tone: value === null ? null : firing ? "warning" : against(value),
      });
    };
    const cap = isFlipped("cap")
      ? plain("cap", "상장주식", orDash(fundamentals?.listedShares, (value) => `${formatVolume(value)}주`), true)
      : plain("cap", "시가총액", orDash(fundamentals?.marketCap, formatKoreanWon));
    return [
      priceOrRate("upper", "상한가", "상한까지", fundamentals?.upperLimit, current),
      priceOrRate("lower", "하한가", "하한까지", fundamentals?.lowerLimit, current),
      viLine("up", "상승VI", "상승VI 발동", vi?.up ?? null),
      viLine("down", "하락VI", "하락VI 발동", vi?.down ?? null),
      cap,
    ];
  }
  const average = summary?.tradeValueWon != null && summary.volume != null && summary.volume > 0 ? Math.round(summary.tradeValueWon / summary.volume) : null;
  const baseLine = isFlipped("base")
    ? itemLine({ label: "평균가", value: orDash(average, won), tone: against(average) }, "base", true)
    : plain("base", "기준가", orDash(previousClose, won));
  const volumeLine = isFlipped("volume")
    ? plain("volume", "동시간비", orDash(sameTimeRatio, decimalPercent), true)
    : plain("volume", "거래량", orDash(summary?.volume, formatVolume));
  const shares = positiveBase(fundamentals?.listedShares);
  const turnover = summary?.volume != null && shares !== null ? (summary.volume / shares) * 100 : null;
  const valueLine = isFlipped("value")
    ? plain("value", "회전율", orDash(turnover, decimalPercent), true)
    : plain("value", "거래대금", orDash(summary?.tradeValueWon, formatKoreanWon));
  return [
    priceOrRate("open", "시가", "시가 등락", summary?.open, base),
    priceOrRate("high", "고가", "고가 등락", summary?.high, base),
    priceOrRate("low", "저가", "저가 등락", summary?.low, base),
    baseLine,
    volumeLine,
    valueLine,
  ];
}

export interface ExpectedFillInput {
  readonly price: number;
  readonly qty: number;
}

export const INFO_CARD_ROWS = 10;
const EXPECTED_LINES = 2;
const EXPECTED_FLIPPED_LABEL = "예상 등락";

export function expectedInfoItems(expected: ExpectedFillInput, previousClose: number | null = null, flipped?: ReadonlySet<InfoKey>): QuoteInfo[] {
  const rate = rateOf(expected.price, positiveBase(previousClose));
  const priceItem: QuoteInfo = flipped?.has("expectedPrice")
    ? { label: EXPECTED_FLIPPED_LABEL, value: orDash(rate, formatPercent), tone: rateTone(rate) }
    : { label: "예상체결가", value: won(expected.price), tone: "warning" };
  return [
    priceItem,
    { label: "예상체결량", value: formatPrice(expected.qty, false), tone: "warning" },
  ];
}

export function infoCardRows(rows: readonly LadderRow[]): number {
  const crossed = rows.slice(0, INFO_CARD_ROWS).findIndex((row) => row.bid != null);
  return crossed < 0 ? Math.min(INFO_CARD_ROWS, rows.length) : crossed;
}

export function expectedItemsOnPage(page: InfoPage, expected: ExpectedFillInput | null, previousClose: number | null = null, flipped?: ReadonlySet<InfoKey>): QuoteInfo[] {
  return page === 0 && expected !== null ? expectedInfoItems(expected, previousClose, flipped) : [];
}

export function placeInfoItems(rows: readonly LadderRow[], body: readonly InfoLine[], expectedItems: readonly QuoteInfo[]): InfoLine[] {
  const capacity = infoCardRows(rows) - 1;
  if (capacity <= 0) return [];
  if (expectedItems.length === 0 || capacity < EXPECTED_LINES) return body.slice(0, capacity);
  const expectedLines = expectedItems.map((entry, index) =>
    index === 0 ? itemLine(entry, "expectedPrice", entry.label === EXPECTED_FLIPPED_LABEL) : itemLine(entry),
  );
  return [...body.slice(0, capacity - EXPECTED_LINES), ...expectedLines];
}
