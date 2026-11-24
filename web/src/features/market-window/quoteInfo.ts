import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolDaySummary } from "../../api/generated/SymbolDaySummary";
import { direction, formatChange, formatDecimal, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { LadderRow } from "./ladder";

export type InfoKey =
  | "open"
  | "high"
  | "low"
  | "dayRange"
  | "base"
  | "change"
  | "volume"
  | "value"
  | "expectedPrice"
  | "upper"
  | "lower"
  | "range52"
  | "cap"
  | "per"
  | "foreign";

export interface QuoteInfo {
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | "warning" | null;
  readonly band?: true;
}

export type InfoLine =
  | { readonly kind: "item"; readonly key?: InfoKey; readonly flipped?: true; readonly item: QuoteInfo }
  | { readonly kind: "range"; readonly key?: InfoKey; readonly flipped?: true; readonly label: string; readonly position: number | null }
  | { readonly kind: "ends"; readonly key?: InfoKey; readonly flipped?: true; readonly low: string; readonly high: string; readonly lowTitle?: string; readonly highTitle?: string };

export type InfoPage = 0 | 1;
export const INFO_TABS: readonly { readonly page: InfoPage; readonly label: string }[] = [{ page: 0, label: "시세" }, { page: 1, label: "종목" }];
export const otherInfoPage = (page: InfoPage): InfoPage => (page === 0 ? 1 : 0);

export type QuoteFundamentals =
  Pick<Fundamentals, "upperLimit" | "lowerLimit" | "high52w" | "low52w" | "marketCap" | "per" | "pbr" | "foreignExhaustionRate">
  & Partial<Pick<Fundamentals, "listedShares" | "eps" | "bps" | "creditRate">>;

export interface QuoteInfoInput {
  readonly price: number | null;
  readonly previousClose: number | null;
  readonly summary: Pick<SymbolDaySummary, "open" | "high" | "low" | "volume" | "tradeValueWon"> | null;
  readonly fundamentals: QuoteFundamentals | null;
  readonly sameTimeRatio?: number | null;
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
const paired = (first: number | null | undefined, second: number | null | undefined, format: (value: number) => string): string =>
  first == null && second == null ? "-" : `${orDash(first, format)}·${orDash(second, format)}`;

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

const itemLine = (value: QuoteInfo, key?: InfoKey, flipped?: boolean): InfoLine => ({
  kind: "item",
  ...(key === undefined ? {} : { key }),
  ...(flipped ? { flipped: true as const } : {}),
  item: value,
});

export function quoteInfoItems(page: InfoPage, { price, previousClose, summary, fundamentals, sameTimeRatio }: QuoteInfoInput, flipped?: ReadonlySet<InfoKey>): InfoLine[] {
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
    const range52Flipped = isFlipped("range52");
    const low52 = fundamentals?.low52w;
    const high52 = fundamentals?.high52w;
    const range52: InfoLine[] = low52 == null || high52 == null || high52 < low52
      ? [plain("range52", "52주 범위", "-", range52Flipped)]
      : [
          { kind: "range", key: "range52", ...(range52Flipped ? { flipped: true as const } : {}), label: "52주 범위", position: rangePosition(price, low52, high52) },
          range52Flipped
            ? { kind: "ends", key: "range52", flipped: true, low: orDash(rateOf(price, positiveBase(low52)), formatPercent), high: orDash(rateOf(price, positiveBase(high52)), formatPercent), lowTitle: "저점 대비", highTitle: "고점 대비" }
            : { kind: "ends", key: "range52", low: won(low52), high: won(high52) },
        ];
    const cap = isFlipped("cap")
      ? plain("cap", "상장주식", orDash(fundamentals?.listedShares, (value) => `${formatVolume(value)}주`), true)
      : plain("cap", "시가총액", orDash(fundamentals?.marketCap, formatKoreanWon));
    const per = isFlipped("per")
      ? plain("per", "EPS·BPS", paired(fundamentals?.eps, fundamentals?.bps, won), true)
      : plain("per", "PER·PBR", paired(fundamentals?.per, fundamentals?.pbr, formatDecimal));
    const foreign = isFlipped("foreign")
      ? plain("foreign", "신용비율", orDash(fundamentals?.creditRate, decimalPercent), true)
      : plain("foreign", "외국인소진율", orDash(fundamentals?.foreignExhaustionRate, decimalPercent));
    return [
      priceOrRate("upper", "상한가", "상한까지", fundamentals?.upperLimit, current),
      priceOrRate("lower", "하한가", "하한까지", fundamentals?.lowerLimit, current),
      ...range52,
      cap,
      per,
      foreign,
    ];
  }
  const dayLow = summary?.low;
  const dayHigh = summary?.high;
  const hasDayRange = dayLow != null && dayHigh != null && dayHigh >= dayLow;
  const amplitude = hasDayRange && base !== null ? ((dayHigh - dayLow) / base) * 100 : null;
  const dayRange: InfoLine[] = isFlipped("dayRange")
    ? [plain("dayRange", "진폭", orDash(amplitude, decimalPercent), true)]
    : hasDayRange
      ? [{ kind: "range", key: "dayRange", label: "당일 범위", position: rangePosition(price, dayLow, dayHigh) }]
      : [];
  const average = summary?.tradeValueWon != null && summary.volume != null && summary.volume > 0 ? Math.round(summary.tradeValueWon / summary.volume) : null;
  const baseLine = isFlipped("base")
    ? itemLine({ label: "평균가", value: orDash(average, won), tone: against(average) }, "base", true)
    : plain("base", "기준가", orDash(previousClose, won));
  const change = price !== null && base !== null ? price - base : null;
  const rate = change !== null && base !== null ? (change / base) * 100 : null;
  const changeTone = against(price);
  const changeLine = isFlipped("change")
    ? signedRate("change", "시가대비", price, positiveBase(summary?.open))
    : itemLine({ label: "전일대비", value: change === null || rate === null ? "-" : `${formatChange(change, false)} ${formatPercent(rate)}`, tone: changeTone, ...(changeTone === null ? {} : { band: true as const }) }, "change");
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
    ...dayRange,
    baseLine,
    changeLine,
    volumeLine,
    valueLine,
  ];
}

export interface ExpectedFillInput {
  readonly price: number;
  readonly qty: number;
}

export const INFO_CARD_ROWS = 9;
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
