import { expect, test } from "vitest";
import { formatEok, signedEok, signedShares, toneOf } from "./rankingFormat";

test("금액은 억으로 줄이고 100억부터는 소수 없이 보인다", () => {
  expect(formatEok(0)).toBe("0.00억");
  expect(formatEok(123_000_000)).toBe("1.23억");
  expect(formatEok(9_999_000_000)).toBe("99.99억");
  expect(formatEok(10_000_000_000)).toBe("100억");
  expect(formatEok(123_456_000_000_000)).toBe("1,234,560억");
  expect(formatEok(-250_000_000)).toBe("−2.50억");
});

test("부호 있는 금액과 수량은 양수에 +를 붙이고 0에는 붙이지 않는다", () => {
  expect(signedEok(500_000_000)).toBe("+5.00억");
  expect(signedEok(0)).toBe("0.00억");
  expect(signedShares(-3_000)).toBe("−3,000");
  expect(signedShares(25_000)).toBe("+3만");
  expect(signedShares(0)).toBe("0");
});

test("부호 색은 양수 up, 음수 down, 0 flat이다", () => {
  expect([toneOf(1), toneOf(-1), toneOf(0)]).toEqual(["up", "down", "flat"]);
});
