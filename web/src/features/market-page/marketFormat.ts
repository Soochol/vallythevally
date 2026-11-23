import { MINUS } from "../../lib/format";

const whole = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatEok = (eok: number): string => {
  const abs = Math.abs(eok);
  const sign = eok < 0 ? MINUS : "";
  return abs >= 10_000 ? `${sign}${oneDecimal.format(abs / 10_000)}조` : `${sign}${whole.format(abs)}억`;
};

export const signedEok = (eok: number): string => (eok > 0 ? "+" : "") + formatEok(eok);

export const formatLevel = (level: number): string => twoDecimals.format(level);

export const signedRate = (rate: number): string => `${rate > 0 ? "+" : rate < 0 ? MINUS : ""}${twoDecimals.format(Math.abs(rate))}%`;

export const toneOf = (value: number): "up" | "down" | "flat" => (value > 0 ? "up" : value < 0 ? "down" : "flat");

export const formatCount = (count: number): string => whole.format(count);

export const pointChangeOf = (level: number, changeRate: number): number => level - level / (1 + changeRate / 100);

export const signedPoints = (points: number): string => `${points > 0 ? "+" : points < 0 ? MINUS : ""}${twoDecimals.format(Math.abs(points))}`;
