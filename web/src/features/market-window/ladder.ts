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
  readonly repeat: boolean;
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
  readonly skipSpreadGap?: boolean;
}

const usablePrice = (price: number | null): price is number => price !== null && Number.isFinite(price) && price > 0;

export function basePrice({ bids, lastPrice, previousClose }: LadderQuotes): number | null {
  if (usablePrice(lastPrice)) return lastPrice;
  const bestBid = Math.max(0, ...bids.map((level) => level.price).filter(usablePrice));
  if (bestBid > 0) return bestBid;
  return usablePrice(previousClose) ? previousClose : null;
}

function gridAround(anchor: number, anchorRow: number, bounds: PriceBounds, rule: TickRule): (number | null)[] {
  const listed = (price: number): number | null => (withinBounds(price, bounds) ? price : null);
  const prices = Array<number | null>(LADDER_ROWS).fill(null);
  prices[anchorRow] = listed(anchor);
  let price = anchor;
  for (let row = anchorRow - 1; row >= 0; row--) {
    price = stepPrice(price, 1, rule);
    prices[row] = listed(price);
  }
  price = anchor;
  for (let row = anchorRow + 1; row < LADDER_ROWS; row++) {
    price = stepPrice(price, -1, rule);
    prices[row] = listed(price);
  }
  return prices;
}

export function gridPrices(base: number | null, bounds: PriceBounds, rule: TickRule): (number | null)[] {
  return base === null ? Array<null>(LADDER_ROWS).fill(null) : gridAround(base, ROWS_ABOVE_BASE, bounds, rule);
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

const SINGLE_PRICE_MAX_LEVELS = 3;

const pricedLevels = (levels: readonly BookLevel[]): BookLevel[] => levels.filter((level) => usablePrice(level.price));

export function isSinglePriceBook({ asks, bids }: LadderQuotes): boolean {
  const askCount = pricedLevels(asks).length;
  const bidCount = pricedLevels(bids).length;
  return askCount <= SINGLE_PRICE_MAX_LEVELS && bidCount <= SINGLE_PRICE_MAX_LEVELS && askCount + bidCount > 0;
}

function singlePricePrices({ asks, bids }: LadderQuotes): (number | null)[] {
  const distinct = (levels: readonly BookLevel[]) => [...new Set(pricedLevels(levels).map((level) => level.price))];
  const askPrices = distinct(asks).sort((a, b) => a - b);
  const bidPrices = distinct(bids).sort((a, b) => b - a);
  const prices = Array<number | null>(LADDER_ROWS).fill(null);
  askPrices.forEach((price, rank) => { prices[ROWS_ABOVE_BASE - 1 - rank] = price; });
  bidPrices.forEach((price, rank) => { prices[ROWS_ABOVE_BASE + rank] = price; });
  return prices;
}

export interface LadderPrices {
  readonly prices: readonly (number | null)[];
  readonly sidesSplit: boolean;
}

const bestAskPrice = ({ asks }: LadderQuotes): number | null => {
  const prices = pricedLevels(asks).map((level) => level.price);
  return prices.length > 0 ? Math.min(...prices) : null;
};

const bestBidPrice = ({ bids }: LadderQuotes): number | null => {
  const prices = pricedLevels(bids).map((level) => level.price);
  return prices.length > 0 ? Math.max(...prices) : null;
};

function askAnchoredPrices(input: LadderInput, bestAsk: number): (number | null)[] {
  const { bounds, tickRule } = input;
  const grid = gridAround(bestAsk, ROWS_ABOVE_BASE - 1, bounds, tickRule);
  const bestBid = bestBidPrice(input);
  const spreadHasGap = bestBid !== null && bestBid < stepPrice(bestAsk, -1, tickRule);
  if (!input.skipSpreadGap || !spreadHasGap) return grid;
  return [...grid.slice(0, ROWS_ABOVE_BASE), ...gridAround(bestBid, ROWS_ABOVE_BASE, bounds, tickRule).slice(ROWS_ABOVE_BASE)];
}

export function defaultLadderPrices(input: LadderInput): LadderPrices {
  if (isSinglePriceBook(input)) return { prices: singlePricePrices(input), sidesSplit: true };
  const bestAsk = bestAskPrice(input);
  if (bestAsk !== null) return { prices: askAnchoredPrices(input, bestAsk), sidesSplit: false };
  return { prices: gridPrices(bestBidPrice(input) ?? basePrice(input), input.bounds, input.tickRule), sidesSplit: false };
}

export function buildLadderRows(prices: readonly (number | null)[], { asks, bids, lastPrice, previousClose }: LadderQuotes, sidesSplit = false): LadderRow[] {
  const asksAt = levelsByPrice(asks);
  const bidsAt = levelsByPrice(bids);
  const priced = prices.map((price, index) => ({
    price,
    ask: price === null || (sidesSplit && index >= ROWS_ABOVE_BASE) ? null : asksAt.get(price) ?? null,
    bid: price === null || (sidesSplit && index < ROWS_ABOVE_BASE) ? null : bidsAt.get(price) ?? null,
  }));
  const largest = Math.max(0, ...priced.flatMap(({ ask, bid }) => [usableQuantity(ask), usableQuantity(bid)]));
  const ratio = (level: BookLevel | null): number => (largest > 0 ? usableQuantity(level) / largest : 0);
  const shown = new Set<number>();
  return priced.map(({ price, ask, bid }, index) => {
    const repeat = price !== null && shown.has(price);
    if (price !== null) shown.add(price);
    return {
      key: price === null ? `blank-${index}` : sidesSplit ? `${index < ROWS_ABOVE_BASE ? "ask" : "bid"}-${price}` : `p-${price}`,
      price,
      ask,
      bid,
      askRatio: ratio(ask),
      bidRatio: ratio(bid),
      current: price !== null && price === lastPrice && !repeat,
      repeat,
      rate: price !== null && previousClose !== null && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null,
    };
  });
}

export function buildLadder(input: LadderInput): LadderRow[] {
  return buildLadderRows(gridPrices(basePrice(input), input.bounds, input.tickRule), input);
}

export function buildDefaultLadder(input: LadderInput): LadderRow[] {
  const { prices, sidesSplit } = defaultLadderPrices(input);
  return buildLadderRows(prices, input, sidesSplit);
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
