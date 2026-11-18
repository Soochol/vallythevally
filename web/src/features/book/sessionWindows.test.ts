import { expect, test } from "vitest";
import { visibleExpected } from "./sessionWindows";

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
