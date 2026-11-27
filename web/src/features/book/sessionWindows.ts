import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Venue } from "../../api/generated/Venue";
import type { ViState } from "../../api/generated/ViState";
import { isMarketOpen } from "../../chart/time";
import { secondOfDay } from "../trades/tape";

export interface ExpectedFill {
  readonly price: number;
  readonly qty: number;
}

interface SecondRange {
  readonly from: number;
  readonly until: number;
}

const clock = (hour: number, minute: number): number => hour * 3600 + minute * 60;

export interface AfterHoursTotals {
  readonly t: UnixSeconds;
  readonly askQty: number;
  readonly bidQty: number;
}

const REGULAR_SESSION: readonly SecondRange[] = [
  { from: clock(9, 0), until: clock(15, 20) },
];

const KRX_CALL_AUCTIONS: readonly SecondRange[] = [
  { from: clock(8, 50), until: clock(9, 0) },
  { from: clock(15, 20), until: clock(15, 30) },
];

const NXT_AFTER_AUCTION: readonly SecondRange[] = [
  { from: clock(15, 30), until: clock(15, 40) },
];

const AFTER_HOURS_CLOSES: readonly SecondRange[] = [
  { from: clock(8, 30), until: clock(8, 41) },
  { from: clock(15, 30), until: clock(16, 1) },
];

function rangeIndexOf(ranges: readonly SecondRange[], time: UnixSeconds): number | null {
  if (!isMarketOpen(time)) return null;
  const second = secondOfDay(time);
  const index = ranges.findIndex((range) => second >= range.from && second < range.until);
  return index < 0 ? null : index;
}

export function isRegularSession(time: UnixSeconds): boolean {
  return rangeIndexOf(REGULAR_SESSION, time) !== null;
}

export function isNxtAfterAuction(time: UnixSeconds, venue: Venue = "combined", nxtEnabled = false): boolean {
  return nxtEnabled && (venue === "nxt" || venue === "combined") && rangeIndexOf(NXT_AFTER_AUCTION, time) !== null;
}

const callAuctionOf = (time: UnixSeconds, venue: Venue, nxtEnabled: boolean): number | null => {
  if (venue !== "nxt") {
    const krx = rangeIndexOf(KRX_CALL_AUCTIONS, time);
    if (krx !== null) return krx;
  }
  if (isNxtAfterAuction(time, venue, nxtEnabled)) return KRX_CALL_AUCTIONS.length;
  return null;
};

export function visibleExpected(
  frameTime: UnixSeconds | null,
  now: UnixSeconds,
  expected: ExpectedFill | null,
  vi?: Pick<ViState, "active" | "triggeredAt"> | null,
  venue: Venue = "combined",
  nxtEnabled = false,
): ExpectedFill | null {
  if (frameTime === null || expected === null || !(expected.price > 0)) return null;
  if (vi?.active && (vi.triggeredAt === null || frameTime >= vi.triggeredAt)) return expected;
  const auction = callAuctionOf(frameTime, venue, nxtEnabled);
  return auction !== null && auction === callAuctionOf(now, venue, nxtEnabled) ? expected : null;
}

export function visibleAfterHours(totals: AfterHoursTotals | null, now: UnixSeconds, venue: Venue = "combined", nxtEnabled = false): AfterHoursTotals | null {
  if (totals === null || venue === "nxt" || (venue === "combined" && nxtEnabled)) return null;
  const window = rangeIndexOf(AFTER_HOURS_CLOSES, totals.t);
  return window !== null && window === rangeIndexOf(AFTER_HOURS_CLOSES, now) ? totals : null;
}
