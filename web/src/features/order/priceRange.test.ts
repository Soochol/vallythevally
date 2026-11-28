import { describe, expect, it } from "vitest";
import { tickSize } from "../market-window/tick";
import { fullRangePrices, scrollTopToCenter, visibleRowRange } from "./priceRange";

const BOUNDS = { lower: 49_000, upper: 91_000 };

describe("전체 호가 가격 목록", () => {
  it("상한에서 하한까지 틱 단위로 빠짐없이 내려간다", () => {
    const prices = fullRangePrices(BOUNDS, "stock")!;
    expect(prices[0]).toBe(91_000);
    expect(prices.at(-1)).toBe(49_000);
    for (let i = 1; i < prices.length; i++) expect(prices[i - 1]! - prices[i]!).toBe(tickSize(prices[i - 1]! - 1, "stock"));
  });

  it("50,000 경계에서 100원 틱이 50원 틱으로 바뀐다", () => {
    const prices = fullRangePrices(BOUNDS, "stock")!;
    const at = prices.indexOf(50_000);
    expect(prices.slice(at - 1, at + 3)).toEqual([50_100, 50_000, 49_950, 49_900]);
    expect(prices).toHaveLength(410 + 1 + 20);
  });

  it("상·하한을 모르면 목록이 없다", () => {
    expect(fullRangePrices({ lower: null, upper: 91_000 }, "stock")).toBeNull();
    expect(fullRangePrices({ lower: 49_000, upper: null }, "stock")).toBeNull();
  });
});

describe("보이는 행 범위", () => {
  it("맨 위에서는 0부터 시작한다", () => {
    expect(visibleRowRange(0, 240, 400, 24, 5)).toEqual({ start: 0, end: 15 });
  });

  it("맨 아래에서는 행 수에서 끝난다", () => {
    expect(visibleRowRange(400 * 24 - 240, 240, 400, 24, 5)).toEqual({ start: 385, end: 400 });
  });

  it("가운데에서는 보이는 행 앞뒤로 여유를 둔다", () => {
    expect(visibleRowRange(2_400, 240, 400, 24, 5)).toEqual({ start: 95, end: 115 });
  });

  it("행 가운데로 맞추는 스크롤 위치", () => {
    expect(scrollTopToCenter(100, 240)).toBe(2_400 + 12 - 120);
    expect(scrollTopToCenter(1, 240)).toBe(0);
  });

  it("초촘촘 16px 행 높이에서도 보이는 행 범위와 가운데 스크롤 위치를 계산한다", () => {
    expect(visibleRowRange(0, 160, 400, 16, 5)).toEqual({ start: 0, end: 15 });
    expect(visibleRowRange(1_600, 160, 400, 16, 5)).toEqual({ start: 95, end: 115 });
    expect(visibleRowRange(400 * 16 - 160, 160, 400, 16, 5)).toEqual({ start: 385, end: 400 });
    expect(scrollTopToCenter(100, 240, 16)).toBe(1_600 + 8 - 120);
    expect(scrollTopToCenter(1, 240, 16)).toBe(0);
  });
});
