import { expect, test } from "vitest";
import { isRegularSession, visibleExpected } from "./sessionWindows";

const at = (date: string, clock: string): number => Date.parse(`${date}T${clock}+09:00`) / 1000;
const WEDNESDAY = "2026-11-18";
const EXPECTED = { price: 32_950, qty: 3_279 };
const TRIGGERED = at(WEDNESDAY, "10:00:00");
const ACTIVE = { active: true, triggeredAt: TRIGGERED };

test("VI 중이면 발동 뒤에 온 프레임의 예상체결이 보인다", () => {
  expect(visibleExpected(TRIGGERED, TRIGGERED + 5, EXPECTED, ACTIVE)).toEqual(EXPECTED);
  expect(visibleExpected(TRIGGERED + 60, TRIGGERED + 60, EXPECTED, ACTIVE)).toEqual(EXPECTED);
});

test("발동 전 프레임과 해제 뒤와 값이 없는 프레임의 예상체결은 보이지 않는다", () => {
  expect(visibleExpected(TRIGGERED - 1, TRIGGERED + 5, EXPECTED, ACTIVE)).toBeNull();
  expect(visibleExpected(TRIGGERED + 200, TRIGGERED + 200, EXPECTED, { active: false, triggeredAt: TRIGGERED })).toBeNull();
  expect(visibleExpected(TRIGGERED + 60, TRIGGERED + 60, EXPECTED, null)).toBeNull();
  expect(visibleExpected(TRIGGERED + 60, TRIGGERED + 60, { price: 0, qty: 1 }, ACTIVE)).toBeNull();
  expect(visibleExpected(null, TRIGGERED, EXPECTED, ACTIVE)).toBeNull();
});

test("정규장은 평일 09:00부터 15:20 전까지다", () => {
  expect(["08:59:59", "09:00:00", "15:19:59", "15:20:00"].map((clock) => isRegularSession(at(WEDNESDAY, clock)))).toEqual([false, true, true, false]);
  expect(isRegularSession(at("2026-11-21", "10:00:00"))).toBe(false);
});
