import { expect, test } from "vitest";
import { formatEokWon, formatShares, formatWon, withSign } from "./format";

test("수량은 주, 금액은 원과 억원으로 쓴다", () => {
  expect(formatShares(1234567)).toBe("1,234,567주");
  expect(formatWon(71500)).toBe("71,500원");
  expect(formatEokWon(1_234_000_000)).toBe("12.34억원");
});

test("부호는 양수에 +, 음수에 U+2212를 붙이고 0에는 붙이지 않는다", () => {
  expect([withSign(5, "5주"), withSign(-5, "5주"), withSign(0, "0주")]).toEqual(["+5주", "−5주", "0주"]);
});
