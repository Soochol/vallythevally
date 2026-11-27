import { expect, test } from "vitest";
import { isNxtAfterAuction, visibleAfterHours, visibleExpected } from "./sessionWindows";

const at = (date: string, clock: string): number => Date.parse(`${date}T${clock}+09:00`) / 1000;
const WEDNESDAY = "2026-11-18";
const SATURDAY = "2026-11-21";
const EXPECTED = { price: 32_950, qty: 3_279 };

test("시가 동시호가 08:55에 프레임과 지금이 모두 안에 있으면 예상체결이 보인다", () => {
  const time = at(WEDNESDAY, "08:55:00");
  expect(visibleExpected(time, time, EXPECTED)).toEqual(EXPECTED);
});

test("08:49:59는 보이지 않는다", () => {
  const time = at(WEDNESDAY, "08:49:59");
  expect(visibleExpected(time, time, EXPECTED)).toBeNull();
});

test("09:00:00은 보이지 않는다", () => {
  const time = at(WEDNESDAY, "09:00:00");
  expect(visibleExpected(time, time, EXPECTED)).toBeNull();
});

test("프레임 08:59:50이 지금 09:00:30에는 보이지 않는다", () => {
  expect(visibleExpected(at(WEDNESDAY, "08:59:50"), at(WEDNESDAY, "09:00:30"), EXPECTED)).toBeNull();
});

test("종가 동시호가 15:25에는 보인다", () => {
  const time = at(WEDNESDAY, "15:25:00");
  expect(visibleExpected(time, time, EXPECTED)).toEqual(EXPECTED);
});

test("15:30:00은 보이지 않는다", () => {
  const time = at(WEDNESDAY, "15:30:00");
  expect(visibleExpected(time, time, EXPECTED)).toBeNull();
});

test("시가 동시호가 프레임이 종가 동시호가의 지금에는 보이지 않는다", () => {
  expect(visibleExpected(at(WEDNESDAY, "08:55:00"), at(WEDNESDAY, "15:25:00"), EXPECTED)).toBeNull();
});

test("예상체결이 null이거나 가격이 0이면 보이지 않는다", () => {
  const time = at(WEDNESDAY, "08:55:00");
  expect(visibleExpected(time, time, null)).toBeNull();
  expect(visibleExpected(time, time, { price: 0, qty: 100 })).toBeNull();
});

test("조회 호가처럼 프레임 시각이 없으면 보이지 않는다", () => {
  expect(visibleExpected(null, at(WEDNESDAY, "08:55:00"), EXPECTED)).toBeNull();
});

test("토요일 08:55는 보이지 않는다", () => {
  const time = at(SATURDAY, "08:55:00");
  expect(visibleExpected(time, time, EXPECTED)).toBeNull();
});

const totalsAt = (date: string, clock: string) => ({ t: at(date, clock), askQty: 13_770, bidQty: 0 });

test("장전 시간외 종가 08:35에 값의 시각과 지금이 모두 안에 있으면 보인다", () => {
  const totals = totalsAt(WEDNESDAY, "08:35:00");
  expect(visibleAfterHours(totals, totals.t)).toEqual(totals);
});

test("시간외 잔량 08:40:00은 지금 08:40:30에 보인다", () => {
  const totals = totalsAt(WEDNESDAY, "08:40:00");
  expect(visibleAfterHours(totals, at(WEDNESDAY, "08:40:30"))).toEqual(totals);
});

test("시간외 잔량 08:40:00은 지금 08:41:00에 보이지 않는다", () => {
  expect(visibleAfterHours(totalsAt(WEDNESDAY, "08:40:00"), at(WEDNESDAY, "08:41:00"))).toBeNull();
});

test("시간외 잔량 08:29:59는 보이지 않는다", () => {
  const totals = totalsAt(WEDNESDAY, "08:29:59");
  expect(visibleAfterHours(totals, totals.t)).toBeNull();
});

test("장후 시간외 종가 15:45에는 보인다", () => {
  const totals = totalsAt(WEDNESDAY, "15:45:00");
  expect(visibleAfterHours(totals, totals.t)).toEqual(totals);
});

test("장전 시간외 잔량은 장후 시간외 종가의 지금에는 보이지 않는다", () => {
  expect(visibleAfterHours(totalsAt(WEDNESDAY, "08:35:00"), at(WEDNESDAY, "15:45:00"))).toBeNull();
});

test("토요일 08:35는 시간외 잔량이 보이지 않는다", () => {
  const totals = totalsAt(SATURDAY, "08:35:00");
  expect(visibleAfterHours(totals, totals.t)).toBeNull();
});

test("시간외 잔량이 없으면 보이지 않는다", () => {
  expect(visibleAfterHours(null, at(WEDNESDAY, "08:35:00"))).toBeNull();
});

test("NXT 애프터마켓 동시호가 15:30~15:40은 NXT 가능 종목의 nxt·combined에서만 예상체결이 보인다", () => {
  const time = at(WEDNESDAY, "15:35:00");
  expect(isNxtAfterAuction(time, "nxt", true)).toBe(true);
  expect(isNxtAfterAuction(time, "combined", true)).toBe(true);
  expect(isNxtAfterAuction(time, "krx", true)).toBe(false);
  expect(isNxtAfterAuction(time, "combined", false)).toBe(false);
  expect(isNxtAfterAuction(at(WEDNESDAY, "15:40:00"), "nxt", true)).toBe(false);
  expect(visibleExpected(time, time, EXPECTED, null, "nxt", true)).toEqual(EXPECTED);
  expect(visibleExpected(time, time, EXPECTED, null, "combined", true)).toEqual(EXPECTED);
  expect(visibleExpected(time, time, EXPECTED, null, "krx", true)).toBeNull();
  expect(visibleExpected(time, time, EXPECTED, null, "combined", false)).toBeNull();
  expect(visibleExpected(at(WEDNESDAY, "15:30:00"), at(WEDNESDAY, "15:30:00"), EXPECTED, null, "nxt", true)).toEqual(EXPECTED);
  expect(visibleExpected(at(WEDNESDAY, "15:39:59"), at(WEDNESDAY, "15:39:59"), EXPECTED, null, "combined", true)).toEqual(EXPECTED);
  expect(visibleExpected(at(WEDNESDAY, "15:40:00"), at(WEDNESDAY, "15:40:00"), EXPECTED, null, "nxt", true)).toBeNull();
});

test("NXT 단독 거래소에서는 KRX 동시호가와 KRX 시간외 종가 잔량이 보이지 않는다", () => {
  const open = at(WEDNESDAY, "08:55:00");
  const close = at(WEDNESDAY, "15:25:00");
  expect(visibleExpected(open, open, EXPECTED, null, "nxt", true)).toBeNull();
  expect(visibleExpected(close, close, EXPECTED, null, "nxt", true)).toBeNull();
  expect(visibleAfterHours(totalsAt(WEDNESDAY, "08:35:00"), at(WEDNESDAY, "08:35:00"), "nxt")).toBeNull();
  expect(visibleAfterHours(totalsAt(WEDNESDAY, "15:45:00"), at(WEDNESDAY, "15:45:00"), "nxt")).toBeNull();
});

test("NXT 가능 종목의 통합 거래소에서는 NXT 프리·애프터마켓과 겹치는 KRX 시간외 종가 잔량이 보이지 않고, KRX 단독·NXT 불가 종목에서는 보인다", () => {
  const pre = totalsAt(WEDNESDAY, "08:35:00");
  const after = totalsAt(WEDNESDAY, "15:52:00");
  expect(visibleAfterHours(pre, pre.t, "combined", true)).toBeNull();
  expect(visibleAfterHours(after, after.t, "combined", true)).toBeNull();
  expect(visibleAfterHours(pre, pre.t, "krx", true)).toEqual(pre);
  expect(visibleAfterHours(after, after.t, "krx", true)).toEqual(after);
  expect(visibleAfterHours(pre, pre.t, "combined", false)).toEqual(pre);
  expect(visibleAfterHours(after, after.t, "combined", false)).toEqual(after);
});
