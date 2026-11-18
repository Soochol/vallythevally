import { describe, expect, it } from "vitest";
import { EXPLORER_ROWS, explorerPrices } from "./priceRange";

const BOUNDS = { lower: 49_000, upper: 91_000 };

describe("전체 호가 탐색", () => {
  it("행 가격은 내림차순이고 상한 위로 행을 만들지 않는다", () => {
    const prices = explorerPrices(70_000, BOUNDS, "stock");
    expect(prices).toHaveLength(EXPLORER_ROWS);
    expect(prices[0]).toBe(71_000);
    expect(prices[10]).toBe(70_000);
    const nearTop = explorerPrices(90_800, BOUNDS, "stock");
    expect(nearTop[0]).toBe(91_000);
    expect(nearTop.filter((p) => p !== null && p > 91_000)).toEqual([]);
  });

  it("하한에 닿으면 남는 행은 비운다", () => {
    const prices = explorerPrices(49_200, BOUNDS, "stock");
    expect(prices.at(-1)).toBeNull();
    expect(Math.min(...prices.filter((p): p is number => p !== null))).toBe(49_000);
  });
});
