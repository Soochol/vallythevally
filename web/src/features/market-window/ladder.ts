export const LADDER_DEPTH = 10;

export interface BookLevel {
  readonly price: number;
  readonly quantity: number;
  readonly change: number;
}

export type LadderSide = "ask" | "bid";

export interface LadderRow {
  readonly key: string;
  readonly side: LadderSide;
  readonly level: BookLevel | null;
  readonly barRatio: number;
  readonly current: boolean;
  readonly rate: number | null;
}

export interface LadderInput {
  readonly asks: readonly BookLevel[];
  readonly bids: readonly BookLevel[];
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
}

const byPriceDescending = (a: BookLevel, b: BookLevel): number => b.price - a.price;

const nearestAsks = (asks: readonly BookLevel[]): BookLevel[] =>
  [...asks].sort((a, b) => a.price - b.price).slice(0, LADDER_DEPTH).sort(byPriceDescending);

const nearestBids = (bids: readonly BookLevel[]): BookLevel[] => [...bids].sort(byPriceDescending).slice(0, LADDER_DEPTH);

const padded = (levels: readonly BookLevel[], at: "top" | "bottom"): (BookLevel | null)[] => {
  const blanks = Array<null>(LADDER_DEPTH - levels.length).fill(null);
  return at === "top" ? [...blanks, ...levels] : [...levels, ...blanks];
};

export function buildLadder({ asks, bids, lastPrice, previousClose }: LadderInput): LadderRow[] {
  const levels: [LadderSide, BookLevel | null][] = [
    ...padded(nearestAsks(asks), "top").map((level): [LadderSide, BookLevel | null] => ["ask", level]),
    ...padded(nearestBids(bids), "bottom").map((level): [LadderSide, BookLevel | null] => ["bid", level]),
  ];
  const largest = Math.max(0, ...levels.map(([, level]) => level?.quantity ?? 0));
  return levels.map(([side, level], index) => ({
    key: `${side}-${index}`,
    side,
    level,
    barRatio: level && largest > 0 ? level.quantity / largest : 0,
    current: level !== null && level.price === lastPrice,
    rate: level && previousClose !== null && previousClose > 0 ? ((level.price - previousClose) / previousClose) * 100 : null,
  }));
}

export interface RatioSplit {
  readonly buy: number;
  readonly sell: number;
}

export function ratioSplit(buy: number, sell: number): RatioSplit {
  const total = buy + sell;
  if (!(total > 0)) return { buy: 50, sell: 50 };
  return { buy: (buy / total) * 100, sell: (sell / total) * 100 };
}
