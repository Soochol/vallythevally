import { describe, expect, it } from "vitest";
import { EXPLORER_ROWS, explorerPrices, movePrice, tickSize } from "./priceRange";

const BOUNDS = { lower: 49_000, upper: 91_000 };

describe("호가 단위", () => {
  it("가격대별 단위를 고른다", () => {
    expect([1_999, 2_000, 4_999, 5_000, 19_999, 20_000, 49_999, 50_000, 199_999, 200_000, 499_999, 500_000].map(tickSize)).toEqual([1, 5, 5, 10, 10, 50, 50, 100, 100, 500, 500, 1_000]);
  });
});

describe("전체 호가 탐색", () => {
  it("호가 단위로 움직인다", () => {
    expect(movePrice(70_000, 1, BOUNDS)).toBe(70_100);
    expect(movePrice(70_000, -3, BOUNDS)).toBe(69_700);
  });

  it("단위가 바뀌는 경계를 건넌다", () => {
    expect(movePrice(50_000, -1, { lower: 1, upper: null })).toBe(49_950);
    expect(movePrice(49_950, 1, { lower: 1, upper: null })).toBe(50_000);
  });

  it("상한과 하한을 넘지 않는다", () => {
    expect(movePrice(90_900, 50, BOUNDS)).toBe(91_000);
    expect(movePrice(49_200, -50, BOUNDS)).toBe(49_000);
  });

  it("한도를 모르면 1원 아래로 내려가지 않는다", () => {
    expect(movePrice(3, -10, { lower: null, upper: null })).toBe(1);
  });

  it("행 가격은 내림차순이고 상한 위로 행을 만들지 않는다", () => {
    const prices = explorerPrices(70_000, BOUNDS);
    expect(prices).toHaveLength(EXPLORER_ROWS);
    expect(prices[0]).toBe(71_000);
    expect(prices[10]).toBe(70_000);
    const nearTop = explorerPrices(90_800, BOUNDS);
    expect(nearTop[0]).toBe(91_000);
    expect(nearTop.filter((p) => p !== null && p > 91_000)).toEqual([]);
  });

  it("하한에 닿으면 남는 행은 비운다", () => {
    const prices = explorerPrices(49_200, BOUNDS);
    expect(prices.at(-1)).toBeNull();
    expect(Math.min(...prices.filter((p): p is number => p !== null))).toBe(49_000);
  });
});
