import { expect, test } from "vitest";
import { financialAxisUnit, fitAxisValue, formatAxisTicks, formatAxisValue } from "./axisFormat";

test.each([
  [-48_054_251_000_000, "KRW", "−48.1조"],
  [1_648_000_000, "KRW", "16.48억"],
  [3_120_000, "volume", "312만"],
  [-1_648_000_000, "volume", "−16.48억"],
  [1_300_000, "price", "1.30M"],
  [44.23, "%", "44.23%"],
  [-12.5, "%", "−12.5%"],
  [1_200, "원/주", "1.2K원/주"],
  [2_000, "원/주", "2K원/주"],
  [0, "원/주", "0원/주"],
] as const)("축 %s %s → %s", (value, unit, expected) => {
  expect(formatAxisValue(value, unit)).toBe(expected);
});

test("금액은 원화와 다른 통화를 구별하고 비율·주당 배당 단위를 보존한다", () => {
  expect(financialAxisUnit("investing_cash_flow", "KRW")).toBe("KRW");
  expect(formatAxisValue(1_300_000, financialAxisUnit("revenue", "USD"))).toBe("1.3MUSD");
  expect(financialAxisUnit("owner_roe", "KRW")).toBe("%");
  expect(financialAxisUnit("debt_ratio", "KRW")).toBe("%");
  expect(financialAxisUnit("dps", "KRW")).toBe("원/주");
});

test("마지막 값과 붙은 눈금만 비우며 음수·여러 선에도 적용한다", () => {
  const ticks = [0, 20, 40, 60, 80];
  expect(formatAxisTicks(ticks, String, [16.48, 76])).toEqual(["0", "", "40", "60", ""]);
  expect(formatAxisTicks([-60, -40, -20, 0], String, [-48.1])).toEqual(["", "", "-20", "0"]);
  expect(formatAxisTicks(ticks, String, [])).toEqual(ticks.map(String));
});

test("축 폭이 부족하면 단위를 남기고 소수·구분자·큰 수 표기를 줄인다", () => {
  expect(fitAxisValue(-1234.56, "index", (text) => text.length <= 6)).toBe("−1,235");
  expect(fitAxisValue(70000, "price", (text) => text.length <= 4)).toBe("70K");
  expect(fitAxisValue(1_234_567_890_000_000_000, "원/주", (text) => text.length <= 7)).toBe("1e18원/주");
  expect(formatAxisTicks([20], String, [20])).toEqual([""]);
  expect(formatAxisTicks([20], String, [])).toEqual(["20"]);
});
