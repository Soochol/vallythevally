import { direction, formatPercent, formatPrice, formatVolume, MINUS } from "../../lib/format";
import { withSign } from "../market-window/format";

export type Tone = "up" | "down" | "flat" | "plain";
export interface Cell {
  text: string;
  tone: Tone;
}

export const DASH: Cell = { text: "—", tone: "flat" };
export const plain = (text: string): Cell => ({ text, tone: "plain" });

const twoDecimals = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eokWhole = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

export function formatEok(won: number): string {
  const inEok = Math.abs(won) / 1e8;
  return `${won < 0 ? MINUS : ""}${inEok >= 100 ? eokWhole.format(inEok) : twoDecimals.format(inEok)}억`;
}

export const signedEok = (won: number): string => (won > 0 ? "+" : "") + formatEok(won);

export const signedShares = (shares: number): string => withSign(shares, formatVolume(Math.abs(shares)));

export const toneOf = (value: number): Tone => direction(value);

export const priceCell = (price: number | null): Cell => (price === null ? DASH : plain(formatPrice(price, false)));
export const rateCell = (rate: number | null): Cell => (rate === null ? DASH : { text: formatPercent(rate), tone: toneOf(rate) });
export const eokCell = (won: number): Cell => plain(formatEok(won));
export const sharesCell = (shares: number): Cell => plain(formatVolume(shares));
export const signedEokCell = (won: number): Cell => ({ text: signedEok(won), tone: toneOf(won) });
export const signedSharesCell = (shares: number): Cell => ({ text: signedShares(shares), tone: toneOf(shares) });
export const signedWonCell = (won: number): Cell => ({ text: withSign(won, formatPrice(Math.abs(won), false)), tone: toneOf(won) });
export const percentCell = (rate: number): Cell => plain(`${twoDecimals.format(rate)}%`);

export function placesGained(places: number | null): Cell {
  if (places === null || places === 0) return { text: "–", tone: "flat" };
  return places > 0 ? { text: `▲${places}`, tone: "up" } : { text: `▼${-places}`, tone: "down" };
}
