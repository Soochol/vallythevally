import type { BookLevel, LadderRow, LadderSide } from "../market-window/ladder";

export interface ExplorerInput {
  readonly prices: readonly (number | null)[];
  readonly asks: readonly BookLevel[];
  readonly bids: readonly BookLevel[];
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
}

export function buildExplorerRows({ prices, asks, bids, lastPrice, previousClose }: ExplorerInput): LadderRow[] {
  const quoted = new Map<number, BookLevel>([...asks, ...bids].map((level) => [level.price, level]));
  const largest = Math.max(0, ...[...quoted.values()].map((level) => (level.quantity > 0 ? level.quantity : 0)));
  const pivot = lastPrice ?? previousClose;
  return prices.map((price, index): LadderRow => {
    const side: LadderSide = pivot !== null && price !== null && price > pivot ? "ask" : "bid";
    if (price === null) return { key: `x-${index}`, side, level: null, barRatio: 0, current: false, rate: null };
    const book = quoted.get(price);
    const level: BookLevel = book ?? { price, quantity: 0, change: 0 };
    return {
      key: `x-${index}`,
      side,
      level,
      unquoted: book === undefined,
      barRatio: book !== undefined && largest > 0 ? Math.max(0, book.quantity) / largest : 0,
      current: price === lastPrice,
      rate: previousClose !== null && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null,
    };
  });
}
