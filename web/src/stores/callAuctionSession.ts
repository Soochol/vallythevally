import { useEffect, useMemo, useState } from "react";
import type { FeedExpected } from "../api/generated/FeedExpected";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { Venue } from "../api/generated/Venue";
import type { ViExpectedPoint } from "../api/generated/ViExpectedPoint";
import { isMarketOpen } from "../chart/time";
import { secondOfDay } from "../features/trades/tape";
import { serverNow, useServerClock } from "./serverClock";
import { appendExpectedPoint, EMPTY_EXPECTED_POINTS } from "./viExpectedStore";

const TICK_INTERVAL_MS = 1000;
const KST_OFFSET_SECS = 9 * 3600;
const DAY_SECS = 86_400;
const MAX_AUCTION_SESSIONS = 200;

const clockSec = (hour: number, minute: number): number => hour * 3600 + minute * 60;

export type CallAuctionKind = "opening" | "closing" | "nxt_after";

export interface CallAuctionWindow {
  readonly kind: CallAuctionKind;
  readonly market: "krx" | "nxt";
  readonly shortLabel: string;
  readonly fullLabel: string;
  readonly startSecond: number;
  readonly endSecond: number;
}

const AUCTION_WINDOWS: readonly CallAuctionWindow[] = [
  {
    kind: "opening",
    market: "krx",
    shortLabel: "장전동시",
    fullLabel: "장전 동시호가 · KRX",
    startSecond: clockSec(8, 50),
    endSecond: clockSec(9, 0),
  },
  {
    kind: "closing",
    market: "krx",
    shortLabel: "장후동시",
    fullLabel: "장후 동시호가 · KRX",
    startSecond: clockSec(15, 20),
    endSecond: clockSec(15, 30),
  },
  {
    kind: "nxt_after",
    market: "nxt",
    shortLabel: "애프터동시",
    fullLabel: "애프터 동시호가 · NXT",
    startSecond: clockSec(15, 30),
    endSecond: clockSec(15, 40),
  },
];

export type CallAuctionViewState =
  | { readonly kind: "inactive" }
  | {
      readonly kind: "active";
      readonly sessionKey: string;
      readonly auction: CallAuctionWindow;
      readonly remainingSec: number;
      readonly expectedSeries: readonly ViExpectedPoint[];
    };

export function activeCallAuction(
  nowSec: UnixSeconds,
  venue: Venue,
  nxtEnabled: boolean,
): CallAuctionWindow | null {
  if (!isMarketOpen(nowSec)) return null;
  const second = secondOfDay(nowSec);
  for (const window of AUCTION_WINDOWS) {
    if (second < window.startSecond || second >= window.endSecond) continue;
    if (window.market === "krx" && venue !== "nxt") return window;
    if (window.market === "nxt" && nxtEnabled && venue !== "krx") return window;
  }
  return null;
}

function kstDayOf(unixSeconds: UnixSeconds): number {
  return Math.floor((unixSeconds + KST_OFFSET_SECS) / DAY_SECS);
}

const auctionSeriesCache = new Map<string, readonly ViExpectedPoint[]>();

function recordAuctionPoint(
  key: string,
  expected: FeedExpected,
  at: UnixSeconds,
): readonly ViExpectedPoint[] {
  const prev = auctionSeriesCache.get(key) ?? EMPTY_EXPECTED_POINTS;
  const next = appendExpectedPoint(prev, expected, at);
  if (next === prev) return prev;
  if (auctionSeriesCache.has(key)) auctionSeriesCache.delete(key);
  auctionSeriesCache.set(key, next);
  while (auctionSeriesCache.size > MAX_AUCTION_SESSIONS) {
    const oldest = auctionSeriesCache.keys().next().value;
    if (oldest === undefined) break;
    auctionSeriesCache.delete(oldest);
  }
  return next;
}

export function clearCallAuctionCache(): void {
  auctionSeriesCache.clear();
}

export function useCallAuctionSession(
  code: SymbolCode,
  venue: Venue,
  nxtEnabled: boolean,
  expected: FeedExpected | null,
  enabled: boolean,
  expectedAt: UnixSeconds | null = null,
): CallAuctionViewState {
  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const [nowSec, setNowSec] = useState<UnixSeconds>(() => Math.floor(serverNow(serverTimeOrigin) / 1000));
  const [, setVersion] = useState(0);

  const auction = enabled ? activeCallAuction(nowSec, venue, nxtEnabled) : null;
  const sessionKey = auction === null ? null : `${code}:${kstDayOf(nowSec)}:${auction.kind}`;

  useEffect(() => {
    if (!enabled) return;
    setNowSec(Math.floor(serverNow(serverTimeOrigin) / 1000));
    const timer = setInterval(() => {
      setNowSec(Math.floor(serverNow(serverTimeOrigin) / 1000));
    }, TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, serverTimeOrigin]);

  useEffect(() => {
    if (sessionKey === null || expected === null) return;
    const stamp = expectedAt ?? Math.floor(serverNow(serverTimeOrigin) / 1000);
    const prev = auctionSeriesCache.get(sessionKey) ?? EMPTY_EXPECTED_POINTS;
    const next = recordAuctionPoint(sessionKey, expected, stamp);
    if (next !== prev) setVersion((v) => v + 1);
  }, [sessionKey, expected?.price, expected?.qty, expectedAt, serverTimeOrigin]);

  return useMemo(() => {
    if (auction === null || sessionKey === null) return { kind: "inactive" };
    const second = secondOfDay(nowSec);
    const remainingSec = Math.max(0, auction.endSecond - second);
    const expectedSeries = auctionSeriesCache.get(sessionKey) ?? EMPTY_EXPECTED_POINTS;
    return {
      kind: "active",
      sessionKey,
      auction,
      remainingSec,
      expectedSeries,
    };
  }, [auction, sessionKey, nowSec, expected?.price, expected?.qty]);
}
