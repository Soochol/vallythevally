import { useEffect } from "react";
import type { FeedBook } from "../../api/generated/FeedBook";
import type { MicroEvent } from "../../api/generated/MicroEvent";
import type { OfiSnapshot } from "../../api/generated/OfiSnapshot";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchMicroEvents, kstYyyymmdd } from "../../api/microEvents";
import { useFrameFold } from "../../lib/useFrameFold";
import { marketSocket } from "../../stores/realtime";
import { ClientMicroDetector, type MicroBookLevel, type MicroCue, toMicroCue } from "./microDetector";

export interface MicroFeedState {
  readonly cuesByPrice: ReadonlyMap<number, MicroCue>;
  readonly ofi: OfiSnapshot | null;
}

const EMPTY_CUES: ReadonlyMap<number, MicroCue> = new Map();
const EMPTY_STATE: MicroFeedState = { cuesByPrice: EMPTY_CUES, ofi: null };

function levelsOf(levels: FeedBook["asks"]): MicroBookLevel[] {
  const out: MicroBookLevel[] = [];
  for (const level of levels) {
    if (level !== null && level.price > 0) {
      out.push({ priceWon: Math.round(level.price), qty: level.qty });
    }
  }
  return out;
}

function mergeEvents(prev: ReadonlyMap<number, MicroCue>, events: readonly MicroEvent[]): ReadonlyMap<number, MicroCue> {
  if (events.length === 0) return prev;
  const next = new Map(prev);
  for (const event of events) {
    const existing = next.get(event.priceWon);
    if (!existing || event.recvMs >= existing.event.recvMs) {
      next.set(event.priceWon, toMicroCue(event));
    }
  }
  return next;
}

export function useMicroFeed(code: SymbolCode, venue: Venue, enabled: boolean): MicroFeedState {
  const [state, fold] = useFrameFold<MicroFeedState>(() => EMPTY_STATE);

  useEffect(() => {
    fold(() => EMPTY_STATE);
    if (!enabled) return;

    let active = true;
    let serverMicroActive = false;
    const fallback = new ClientMicroDetector();
    const abort = new AbortController();

    fetchMicroEvents(code, kstYyyymmdd(Date.now()), abort.signal).then(
      (page) => {
        if (!active || abort.signal.aborted || page.events.length === 0) return;
        fold((prev) => ({ ...prev, cuesByPrice: mergeEvents(prev.cuesByPrice, page.events) }));
      },
      () => {},
    );

    const stopMicro = marketSocket.subscribeFeed({ symbol: code, kind: "micro", venue }, (message) => {
      if (!active) return;
      if (message.type === "feed_micro") {
        serverMicroActive = true;
        fold((prev) => ({ ...prev, cuesByPrice: mergeEvents(prev.cuesByPrice, [message.event]) }));
      } else if (message.type === "feed_ofi") {
        serverMicroActive = true;
        fold((prev) => ({ ...prev, ofi: message.ofi }));
      } else if (message.type === "resync") {
        serverMicroActive = false;
        fallback.reset();
      }
    });

    const stopTap = marketSocket.onFeedTap((request, event) => {
      if (!active || serverMicroActive || request.symbol !== code) return;
      if (request.kind === "trades" && event.type === "feed_trades") {
        for (const trade of event.trades) {
          fallback.onTrade(trade.t * 1000, Math.round(trade.price), trade.qty);
        }
      } else if (request.kind === "book" && event.type === "feed_book") {
        const recvMs = event.book.t * 1000;
        const { events, ofi } = fallback.onBook(recvMs, levelsOf(event.book.asks), levelsOf(event.book.bids));
        fold((prev) => ({
          cuesByPrice: events.length > 0 ? mergeEvents(prev.cuesByPrice, events) : prev.cuesByPrice,
          ofi,
        }));
      }
    });

    return () => {
      active = false;
      abort.abort();
      stopMicro();
      stopTap();
    };
  }, [code, venue, enabled, fold]);

  return state;
}
