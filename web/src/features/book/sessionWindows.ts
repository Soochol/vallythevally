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

const CALL_AUCTIONS: readonly SecondRange[] = [
  { from: clock(8, 50), until: clock(9, 0) },
  { from: clock(15, 20), until: clock(15, 30) },
];

function callAuctionOf(time: UnixSeconds): number | null {
  if (!isMarketOpen(time)) return null;
  const second = secondOfDay(time);
  const index = CALL_AUCTIONS.findIndex((range) => second >= range.from && second < range.until);
  return index < 0 ? null : index;
}

export function visibleExpected(frameTime: UnixSeconds | null, now: UnixSeconds, expected: ExpectedFill | null): ExpectedFill | null {
  if (frameTime === null || expected === null || !(expected.price > 0)) return null;
  const auction = callAuctionOf(frameTime);
  return auction !== null && auction === callAuctionOf(now) ? expected : null;
}
