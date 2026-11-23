import type { FeedTrade } from "../../api/generated/FeedTrade";
import type { TradePrint } from "../../api/generated/TradePrint";
import type { TradeTape } from "../../api/generated/TradeTape";
import type { Venue } from "../../api/generated/Venue";

export const MAX_TAPE_ROWS = 500;
export const BIG_TRADE_WON = 30_000_000;
export const RECENT_RATIO_ROWS = 100;

export const MIN_AMOUNT_OPTIONS = [
  { value: "all", label: "전체", won: 0 },
  { value: "30m", label: "3천만", won: 30_000_000 },
  { value: "100m", label: "1억", won: 100_000_000 },
] as const;

export type MinAmountKey = (typeof MIN_AMOUNT_OPTIONS)[number]["value"];

export const minAmountWon = (key: MinAmountKey): number => MIN_AMOUNT_OPTIONS.find((o) => o.value === key)!.won;


export type TradeSide = "buy" | "sell" | "none";
export type TradeOrigin = "history" | "live";

export interface TradeRow {
  readonly kind: "trade";
  readonly key: string;
  readonly origin: TradeOrigin;
  readonly secondOfDay: number;
  readonly price: number;
  readonly quantity: number;
  readonly side: TradeSide;
  readonly venue: Venue | null;
  readonly receivedAt: number;
}

export interface LastTrade {
  readonly price: number;
  readonly t: number;
}

export interface GapRow {
  readonly kind: "gap";
  readonly key: string;
  readonly fromSecond: number;
  readonly toSecond: number | null;
}

export type TapeEntry = TradeRow | GapRow;

export interface VenueTotals {
  readonly krx: number;
  readonly nxt: number;
  readonly unknown: number;
}

const NO_TOTALS: VenueTotals = { krx: 0, nxt: 0, unknown: 0 };

export interface TapeState {
  readonly history: readonly TradeRow[];
  readonly historyVenue: Venue | null;
  readonly historyTotals: VenueTotals;
  readonly live: readonly TapeEntry[];
  readonly liveTotals: VenueTotals;
  readonly pending: readonly TapeEntry[];
  readonly holding: boolean;
  readonly firstLiveSecond: number | null;
  readonly strength: number | null;
  readonly lastTrade: LastTrade | null;
  readonly nextKey: number;
}

export const emptyTape: TapeState = {
  history: [],
  historyVenue: null,
  historyTotals: NO_TOTALS,
  live: [],
  liveTotals: NO_TOTALS,
  pending: [],
  holding: false,
  firstLiveSecond: null,
  strength: null,
  lastTrade: null,
  nextKey: 0,
};

export type TapeAction =
  | { type: "history"; tape: TradeTape }
  | { type: "live"; trades: readonly FeedTrade[]; receivedAt: number }
  | { type: "link"; live: boolean; at: number }
  | { type: "resync"; at: number }
  | { type: "hold" }
  | { type: "release" }
  | { type: "flush" }
  | { type: "reset" };

const KST_OFFSET_SECONDS = 9 * 3600;
const DAY_SECONDS = 86_400;

export const secondOfDay = (unixSeconds: number): number => (((Math.floor(unixSeconds) + KST_OFFSET_SECONDS) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;

export function parseClockSecond(clock: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(clock);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function formatSecond(second: number): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(second / 3600))}:${two(Math.floor((second % 3600) / 60))}:${two(second % 60)}`;
}

const sideOf = (signedQuantity: number): TradeSide => (signedQuantity > 0 ? "buy" : signedQuantity < 0 ? "sell" : "none");

export const amountWon = (row: Pick<TradeRow, "price" | "quantity">): number => row.price * row.quantity;

export const isBigTrade = (row: Pick<TradeRow, "price" | "quantity">): boolean => amountWon(row) >= BIG_TRADE_WON;

export function matchesVenue(row: TradeRow, venue: Venue): boolean {
  if (venue === "combined") return true;
  if (row.venue === null) return row.origin === "history";
  return row.venue === venue;
}

export const passesMinAmount = (row: TradeRow, minWon: number): boolean => amountWon(row) >= minWon;

function addTotals(totals: VenueTotals, row: TradeRow): VenueTotals {
  if (row.venue === "krx") return { ...totals, krx: totals.krx + row.quantity };
  if (row.venue === "nxt") return { ...totals, nxt: totals.nxt + row.quantity };
  return { ...totals, unknown: totals.unknown + row.quantity };
}

export function cumulativeQuantity(state: TapeState, venue: Venue): number {
  if (venue === "combined") return [state.historyTotals, state.liveTotals].reduce((sum, t) => sum + t.krx + t.nxt + t.unknown, 0);
  const own = (t: VenueTotals) => (venue === "krx" ? t.krx : t.nxt);
  return own(state.historyTotals) + state.historyTotals.unknown + own(state.liveTotals);
}

const totalsOf = (rows: readonly TradeRow[]): VenueTotals => rows.reduce(addTotals, NO_TOTALS);

const newestFirstCap = <T>(rows: readonly T[]): readonly T[] => (rows.length > MAX_TAPE_ROWS ? rows.slice(0, MAX_TAPE_ROWS) : rows);

function settleHistory(state: TapeState): TapeState {
  if (state.holding || state.firstLiveSecond === null) return state;
  const history = state.history.filter((row) => row.secondOfDay < state.firstLiveSecond!);
  return history.length === state.history.length ? state : { ...state, history, historyTotals: totalsOf(history) };
}

function historyRows(tape: TradeTape, startKey: number): TradeRow[] {
  const rows: TradeRow[] = [];
  tape.trades.forEach((print: TradePrint, index) => {
    const second = parseClockSecond(print.time);
    if (second === null) return;
    rows.push({ kind: "trade", key: `h${startKey + index}`, origin: "history", secondOfDay: second, price: print.price, quantity: Math.abs(print.quantity), side: sideOf(print.quantity), venue: print.exchange, receivedAt: 0 });
  });
  return rows;
}

function withNewest(state: TapeState, entries: readonly TapeEntry[]): TapeState {
  return state.holding ? { ...state, pending: [...entries, ...state.pending] } : { ...state, live: newestFirstCap([...entries, ...state.live]) };
}

function newestEntry(state: TapeState): TapeEntry | undefined {
  return state.pending[0] ?? state.live[0];
}

function replaceNewest(state: TapeState, entry: TapeEntry): TapeState {
  if (state.pending.length > 0) return { ...state, pending: [entry, ...state.pending.slice(1)] };
  return { ...state, live: [entry, ...state.live.slice(1)] };
}

function liveTrades(state: TapeState, trades: readonly FeedTrade[], receivedAt: number): TapeState {
  if (trades.length === 0) return state;
  const rows: TradeRow[] = trades.map((trade, index) => ({
    kind: "trade",
    key: `l${state.nextKey + index}`,
    origin: "live",
    secondOfDay: secondOfDay(trade.t),
    price: trade.price,
    quantity: Math.abs(trade.qty),
    side: sideOf(trade.qty),
    venue: trade.venue,
    receivedAt,
  }));
  const firstLiveSecond = state.firstLiveSecond ?? Math.min(...rows.map((row) => row.secondOfDay));
  const strength = [...trades].reverse().find((trade) => trade.strength !== null)?.strength ?? state.strength;
  const last = trades[trades.length - 1]!;
  const added = withNewest({ ...state, firstLiveSecond, strength, lastTrade: { price: last.price, t: last.t }, nextKey: state.nextKey + rows.length }, rows.toReversed());
  return settleHistory({ ...added, liveTotals: rows.reduce(addTotals, state.liveTotals) });
}

function openGap(state: TapeState, at: number): TapeState {
  const newest = newestEntry(state);
  if (newest?.kind === "gap" && newest.toSecond === null) return state;
  const gap: GapRow = { kind: "gap", key: `g${state.nextKey}`, fromSecond: secondOfDay(at), toSecond: null };
  return withNewest({ ...state, nextKey: state.nextKey + 1 }, [gap]);
}

function closeGap(state: TapeState, at: number): TapeState {
  const newest = newestEntry(state);
  if (newest?.kind !== "gap" || newest.toSecond !== null) return state;
  return replaceNewest(state, { ...newest, toSecond: secondOfDay(at) });
}

export function tapeReducer(state: TapeState, action: TapeAction): TapeState {
  switch (action.type) {
    case "reset":
      return { ...emptyTape, nextKey: state.nextKey };
    case "history": {
      const history = newestFirstCap(historyRows(action.tape, state.nextKey));
      return settleHistory({ ...state, history, historyVenue: action.tape.venue, historyTotals: totalsOf(history), nextKey: state.nextKey + action.tape.trades.length });
    }
    case "live":
      return liveTrades(state, action.trades, action.receivedAt);
    case "link":
      return action.live ? closeGap(state, action.at) : openGap(state, action.at);
    case "resync":
      return closeGap(openGap(state, action.at), action.at);
    case "hold":
      return { ...state, holding: true };
    case "release":
    case "flush": {
      const flushed = { ...state, live: newestFirstCap([...state.pending, ...state.live]), pending: [] };
      const settled = settleHistory({ ...flushed, holding: false });
      return { ...settled, holding: action.type === "flush" && state.holding };
    }
  }
}

export interface TapeView {
  readonly entries: readonly TapeEntry[];
  readonly pendingCount: number;
}

export function visibleEntries(state: TapeState, venue: Venue, minWon: number): TapeView {
  const keep = (entry: TapeEntry) => entry.kind === "gap" || (matchesVenue(entry, venue) && passesMinAmount(entry, minWon));
  const entries = newestFirstCap([...state.live, ...state.history]).filter(keep);
  return { entries, pendingCount: state.pending.filter((entry) => entry.kind === "trade" && keep(entry)).length };
}

export interface BuySellSplit {
  readonly buy: number;
  readonly sell: number;
}

export function recentBuySell(entries: readonly TapeEntry[]): BuySellSplit {
  let buy = 0;
  let sell = 0;
  let seen = 0;
  for (const entry of entries) {
    if (entry.kind !== "trade") continue;
    if (seen++ >= RECENT_RATIO_ROWS) break;
    if (entry.side === "buy") buy += entry.quantity;
    else if (entry.side === "sell") sell += entry.quantity;
  }
  return { buy, sell };
}
