import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolKind } from "../../api/generated/SymbolKind";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Venue } from "../../api/generated/Venue";
import type { ViState } from "../../api/generated/ViState";
import { type AfterHoursState, type BookState, type BookView, type StripTotals, stripTotals } from "../book/bookModel";
import { isNxtAfterAuction, isRegularSession, visibleAfterHours, visibleExpected } from "../book/sessionWindows";
import { type ReplayReference, replayReference, type ReplayView } from "../book-replay/replay";
import { buildDefaultLadder, type LadderQuotes, type LadderRow, trimSinglePriceLevels } from "./ladder";
import { type TickRule, tickRuleOf } from "./tick";

export interface LadderBounds {
  readonly lower: number | null;
  readonly upper: number | null;
}

export interface LadderMarketInput {
  readonly book: BookState;
  readonly afterHours: AfterHoursState | null;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly fundamentals: Fundamentals | undefined;
  readonly symbolKind: SymbolKind | null;
  readonly replay: ReplayView;
  readonly vi: ViState | null;
  readonly nxtVi?: ViState | null;
  readonly venue?: Venue;
  readonly nxtEnabled?: boolean;
  readonly nowSeconds: UnixSeconds;
  readonly serverNowSeconds: UnixSeconds;
  readonly skipSpreadGap: boolean;
}

export interface ResolvedLadderMarket {
  readonly liveView: BookView | null;
  readonly view: BookView | null;
  readonly bounds: LadderBounds;
  readonly replayRef: ReplayReference | null;
  readonly replayLocked: boolean;
  readonly regularSession: boolean;
  readonly tickRule: TickRule;
  readonly liveQuotes: LadderQuotes | null;
  readonly pastRows: readonly LadderRow[];
  readonly expected: BookView["expected"];
  readonly activeVi: ViState | null;
  readonly totals: StripTotals;
  readonly headPrice: number | null;
  readonly headPreviousClose: number | null;
}

function viForExpected(venue: Venue, krxVi: ViState | null, nxtVi: ViState | null): ViState | null {
  if (venue === "nxt") return nxtVi;
  if (venue === "krx") return krxVi;
  if (krxVi?.active) return krxVi;
  if (nxtVi?.active) return nxtVi;
  return krxVi;
}

export function resolveLadderMarket(input: LadderMarketInput): ResolvedLadderMarket {
  const { book, afterHours, lastPrice, previousClose, fundamentals, symbolKind, replay, vi, nowSeconds, serverNowSeconds, skipSpreadGap } = input;
  const venue = input.venue ?? "combined";
  const nxtEnabled = input.nxtEnabled ?? false;
  const nxtVi = input.nxtVi ?? null;
  const liveView = book.phase === "empty" ? null : book.view;
  const bounds: LadderBounds = { lower: fundamentals?.lowerLimit ?? null, upper: fundamentals?.upperLimit ?? null };
  const replayLocked = replay.kind !== "live";
  const replayRef = replay.kind === "past" ? replayReference(replay.at, serverNowSeconds, { previousClose, bounds }) : null;
  const view = replay.kind === "live" ? liveView : replay.kind === "past" ? replay.book : null;
  const tickRule = tickRuleOf(symbolKind, view ? [...view.asks, ...view.bids].map((level) => level.price) : []);
  const regularSession = isRegularSession(nowSeconds);
  const nxtAuctionDepth = replay.kind === "live" && liveView !== null && isNxtAfterAuction(nowSeconds, venue, nxtEnabled);
  const liveQuotes: LadderQuotes | null = liveView
    ? {
        asks: nxtAuctionDepth ? trimSinglePriceLevels(liveView.asks, "ask") : liveView.asks,
        bids: nxtAuctionDepth ? trimSinglePriceLevels(liveView.bids, "bid") : liveView.bids,
        lastPrice,
        previousClose,
      }
    : null;
  const pastRows: readonly LadderRow[] =
    replay.kind === "past" && replayRef !== null
      ? buildDefaultLadder({
          asks: replay.book.asks,
          bids: replay.book.bids,
          lastPrice: replay.lastPrice,
          previousClose: replayRef.previousClose,
          bounds: replayRef.bounds,
          skipSpreadGap,
          tickRule,
        })
      : [];
  const expectedVi = viForExpected(venue, vi, nxtVi);
  const activeVi = expectedVi?.active === true ? expectedVi : null;
  const expected = replay.kind === "live" && liveView !== null ? visibleExpected(liveView.t, nowSeconds, liveView.expected, expectedVi, venue, nxtEnabled) : null;
  const liveTotals = stripTotals(liveView && { ask: liveView.totalAsk, bid: liveView.totalBid }, visibleAfterHours(afterHours?.totals ?? null, nowSeconds, venue));
  const totals: StripTotals =
    replay.kind === "live"
      ? liveTotals
      : replay.kind === "past"
        ? { ask: replay.book.totalAsk, bid: replay.book.totalBid, source: "regular", description: null }
        : { ask: null, bid: null, source: "regular", description: null };
  const headPrice = replay.kind === "live" ? lastPrice : replay.kind === "past" ? replay.lastPrice : null;
  const headPreviousClose = replay.kind === "live" ? previousClose : replayRef?.previousClose ?? null;

  return {
    liveView,
    view,
    bounds,
    replayRef,
    replayLocked,
    regularSession,
    tickRule,
    liveQuotes,
    pastRows,
    expected,
    activeVi,
    totals,
    headPrice,
    headPreviousClose,
  };
}
