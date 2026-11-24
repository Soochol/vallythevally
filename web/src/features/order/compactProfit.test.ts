import { describe, expect, it } from "vitest";
import { compactProfitText } from "./compactProfit";

describe("짧은 손익 글자", () => {
  it.each([
    [0, "0원"],
    [4_800, "+4,800원"],
    [-9_999, "−9,999원"],
    [10_000, "+1.0만"],
    [-12_345, "−1.2만"],
    [12_345_678, "+1,234.5만"],
    [99_999_999, "+9,999.9만"],
    [100_000_000, "+1.00억"],
    [-123_456_789, "−1.23억"],
  ])("손익을 짧게 줄일 때 %i원은 %s이다", (won, text) => {
    expect(compactProfitText(won)).toBe(text);
  });
});
