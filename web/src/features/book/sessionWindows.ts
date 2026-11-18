import type { UnixSeconds } from "../../api/generated/UnixSeconds";
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

const CALL_AUCTIONS: readonly SecondRange[] = [
  { from: clock(8, 50), until: clock(9, 0) },
  { from: clock(15, 20), until: clock(15, 30) },
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

const callAuctionOf = (time: UnixSeconds): number | null => rangeIndexOf(CALL_AUCTIONS, time);

export function visibleExpected(frameTime: UnixSeconds | null, now: UnixSeconds, expected: ExpectedFill | null): ExpectedFill | null {
  if (frameTime === null || expected === null || !(expected.price > 0)) return null;
  const auction = callAuctionOf(frameTime);
  return auction !== null && auction === callAuctionOf(now) ? expected : null;
}

export function visibleAfterHours(totals: AfterHoursTotals | null, now: UnixSeconds): AfterHoursTotals | null {
  if (totals === null) return null;
  const window = rangeIndexOf(AFTER_HOURS_CLOSES, totals.t);
  return window !== null && window === rangeIndexOf(AFTER_HOURS_CLOSES, now) ? totals : null;
}
