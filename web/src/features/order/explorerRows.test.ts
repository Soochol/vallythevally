import { describe, expect, it } from "vitest";
import { buildExplorerRows } from "./explorerRows";

const level = (price: number, quantity: number) => ({ price, quantity, change: 0 });

describe("전체 호가 행", () => {
  const rows = buildExplorerRows({
    prices: [70_300, 70_200, 70_100, 70_000, 69_900, null],
    asks: [level(70_100, 50), level(70_200, 40)],
    bids: [level(70_000, 80)],
    lastPrice: 70_000,
    previousClose: 70_000,
  });

  it("10호가 밖 가격은 잔량을 비운다", () => {
    expect(rows.map((r) => r.unquoted === true)).toEqual([true, false, false, false, true, false]);
    expect(rows[0]!.barRatio).toBe(0);
  });

  it("현재가보다 높으면 매도 쪽이고 현재가 행을 표시한다", () => {
    expect(rows.map((r) => r.side)).toEqual(["ask", "ask", "ask", "bid", "bid", "bid"]);
    expect(rows.map((r) => r.current)).toEqual([false, false, false, true, false, false]);
  });

  it("범위 밖 빈 행은 가격이 없다", () => {
    expect(rows[5]!.level).toBeNull();
  });
});
