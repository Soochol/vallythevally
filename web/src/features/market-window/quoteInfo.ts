import { formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";

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
