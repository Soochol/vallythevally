import { stepPrice, type PriceBounds, type TickRule, withinBounds } from "./tick";

export const LADDER_ROWS = 20;
export const ROWS_ABOVE_BASE = 10;

export interface BookLevel {
  readonly price: number;
  readonly quantity: number;
  readonly change: number;
}

export interface LadderRow {
  readonly key: string;
  readonly price: number | null;
  readonly ask: BookLevel | null;
  readonly bid: BookLevel | null;
  readonly askRatio: number;
  readonly bidRatio: number;
  readonly current: boolean;
  readonly rate: number | null;
}

export interface LadderQuotes {
  readonly asks: readonly BookLevel[];
  readonly bids: readonly BookLevel[];
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
}

export interface LadderInput extends LadderQuotes {
  readonly bounds: PriceBounds;
  readonly tickRule: TickRule;
}

const usablePrice = (price: number | null): price is number => price !== null && Number.isFinite(price) && price > 0;

export function basePrice({ bids, lastPrice, previousClose }: LadderQuotes): number | null {
  if (usablePrice(lastPrice)) return lastPrice;
  const bestBid = Math.max(0, ...bids.map((level) => level.price).filter(usablePrice));
  if (bestBid > 0) return bestBid;
  return usablePrice(previousClose) ? previousClose : null;
}

export function gridPrices(base: number | null, bounds: PriceBounds, rule: TickRule): (number | null)[] {
  if (base === null) return Array<null>(LADDER_ROWS).fill(null);
  const listed = (price: number): number | null => (withinBounds(price, bounds) ? price : null);
  const above: (number | null)[] = [];
  let price = base;
  for (let tick = 0; tick < ROWS_ABOVE_BASE; tick++) {
    price = stepPrice(price, 1, rule);
    above.unshift(listed(price));
  }
  const below: (number | null)[] = [listed(base)];
  price = base;
  for (let tick = 1; tick < LADDER_ROWS - ROWS_ABOVE_BASE; tick++) {
    price = stepPrice(price, -1, rule);
    below.push(listed(price));
  }
  return [...above, ...below];
}

const usableQuantity = (level: BookLevel | null): number => (level !== null && Number.isFinite(level.quantity) && level.quantity > 0 ? level.quantity : 0);

function levelsByPrice(levels: readonly BookLevel[]): Map<number, BookLevel> {
  const byPrice = new Map<number, BookLevel>();
  for (const level of levels) {
    const same = byPrice.get(level.price);
    byPrice.set(level.price, same ? { price: level.price, quantity: same.quantity + level.quantity, change: same.change + level.change } : level);
  }
  return byPrice;
}

export function buildLadderRows(prices: readonly (number | null)[], { asks, bids, lastPrice, previousClose }: LadderQuotes): LadderRow[] {
  const asksAt = levelsByPrice(asks);
  const bidsAt = levelsByPrice(bids);
  const priced = prices.map((price) => ({ price, ask: price === null ? null : asksAt.get(price) ?? null, bid: price === null ? null : bidsAt.get(price) ?? null }));
  const largest = Math.max(0, ...priced.flatMap(({ ask, bid }) => [usableQuantity(ask), usableQuantity(bid)]));
  const ratio = (level: BookLevel | null): number => (largest > 0 ? usableQuantity(level) / largest : 0);
  return priced.map(({ price, ask, bid }, index) => ({
    key: price === null ? `blank-${index}` : `p-${price}`,
    price,
    ask,
    bid,
    askRatio: ratio(ask),
    bidRatio: ratio(bid),
    current: price !== null && price === lastPrice,
    rate: price !== null && previousClose !== null && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null,
  }));
}

export function buildLadder(input: LadderInput): LadderRow[] {
  return buildLadderRows(gridPrices(basePrice(input), input.bounds, input.tickRule), input);
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
