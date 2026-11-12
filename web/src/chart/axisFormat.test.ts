import { expect, test } from "vitest";
import { axisPriceFormat, distinctAxisTicks, financialAxisUnit, fitAxisValue, formatAxisTicks, formatAxisValue } from "./axisFormat";

test.each([
  [-48_054_251_000_000, "KRW", "−48.1조"],
  [1_648_000_000, "KRW", "16.48억"],
  [3_120_000, "volume", "312만"],
  [-1_648_000_000, "volume", "−16.48억"],
  [1_300_000, "price", "1.30M"],
  [1_300_000_000, "price", "1.30B"],
  [1_300_000_000_000, "price", "1.30T"],
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

test("축 좌표로 로그와 선형의 충돌을 판정하고 눈금을 모두 지우지 않는다", () => {
  const geometry = { toCoordinate: (value: number) => Math.log10(value) * 30, lastCoordinates: () => [90] };
  expect(formatAxisTicks([10, 100, 1000, 10000], ["10", "100", "1000", "10000"], geometry, 11)).toEqual(["10", "100", "", "10000"]);
  const crowded = { toCoordinate: (value: number) => value, lastCoordinates: () => [20] };
  expect(formatAxisTicks([19, 20, 21], ["19", "20", "21"], crowded, 11).filter(Boolean)).toHaveLength(1);
  expect(formatAxisTicks([20], ["20"], crowded, 11)).toEqual(["20"]);
});

test("축 폭이 부족하면 단위를 남기고 소수·구분자·큰 수 표기를 줄인다", () => {
  expect(fitAxisValue(-1234.56, "index", (text) => text.length <= 6)).toBe("−1,235");
  expect(fitAxisValue(70000, "price", (text) => text.length <= 4)).toBe("70K");
  expect(fitAxisValue(1_234_567_890_000_000_000, "원/주", (text) => text.length <= 7)).toBe("1e18원/주");
});

test.each([
  ["KRW", [-48_140_000_000_000, -48_130_000_000_000, -48_120_000_000_000]],
  ["volume", [3120000, 3121000, 3122000]],
  ["KRW", [1_648_000_000, 1_649_000_000, 1_650_000_000]],
  [{ currency: "USD" }, [1_200_000_000, 1_300_000_000, 1_400_000_000]],
  ["price", [1296000, 1296100, 1296200]],
  ["%", [129600, 129610, 129620]],
  ["원/주", [1200, 1210, 1220]],
] as const)("%s 눈금의 최종 표기는 모두 구분된다", (unit, values) => {
  const format = axisPriceFormat(unit, 0.01);
  const labels = format.tickmarksFormatter([...values]);
  expect(labels.every((label) => label.length > 0)).toBe(true);
  expect(new Set(labels).size).toBe(values.length);
});

test.each([
  ["KRW", [-48_140_000_000_000, -48_130_000_000_000, -48_120_000_000_000]],
  ["volume", [3120000, 3121000, 3122000]],
  ["KRW", [1_648_000_000, 1_649_000_000, 1_650_000_000]],
  [{ currency: "USD" }, [1_200_000_000, 1_300_000_000, 1_400_000_000]],
  ["price", [1296000, 1296100, 1296200]],
  ["%", [129600, 129610, 129620]],
  ["원/주", [1200, 1300, 1400]],
] as const)("%s 눈금은 폭을 맞춘 최종 문자열도 구분된다", (unit, values) => {
  const labels = distinctAxisTicks([...values], unit, (text) => text.length <= 8);
  expect(labels.every((label) => label.length > 0 && label.length <= 8)).toBe(true);
  expect(new Set(labels).size).toBe(values.length);
});

test("극단 값이나 긴 통화 단위도 지수 표기로 남기고 다음 패널 표기를 계속한다", () => {
  const fits = (text: string) => text.length <= 8;
  for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE]) {
    expect(fitAxisValue(value, { currency: "확인하지 못한 아주 긴 통화 단위" }, fits).length).toBeLessThanOrEqual(8);
  }
  expect(fitAxisValue(1_648_000_000, "KRW", fits)).toBe("16.48억");
});
