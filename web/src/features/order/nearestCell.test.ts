import { expect, test } from "vitest";
import { findNearestOrderCell, type OrderCellRect } from "./nearestCell";

const sellCell = (price: number, top: number): OrderCellRect => ({
  side: "sell",
  price,
  rowKey: `ask:${price}`,
  left: 12,
  right: 76,
  top,
  bottom: top + 24,
});

const buyCell = (price: number, top: number): OrderCellRect => ({
  side: "buy",
  price,
  rowKey: `bid:${price}`,
  left: 344,
  right: 408,
  top,
  bottom: top + 24,
});

const cells: readonly OrderCellRect[] = [
  sellCell(70_200, 100),
  sellCell(70_100, 124),
  buyCell(70_200, 100),
  buyCell(70_100, 124),
];

test("칸 경계 바로 위·아래나 미세한 틈에서는 중심이 더 가까운 가격 칸을 고른다", () => {
  expect(findNearestOrderCell(cells, 40, 123.5)?.price).toBe(70_200);
  expect(findNearestOrderCell(cells, 40, 124.5)?.price).toBe(70_100);
  expect(findNearestOrderCell(cells, 40, 124)?.price).toBe(70_200);

  const gapped: readonly OrderCellRect[] = [
    { ...sellCell(70_200, 100), bottom: 123 },
    { ...sellCell(70_100, 125), top: 125 },
  ];
  expect(findNearestOrderCell(gapped, 40, 123.4)?.price).toBe(70_200);
  expect(findNearestOrderCell(gapped, 40, 124.6)?.price).toBe(70_100);
});

test("매도·매수 칸 바깥 경계와 안쪽 2px 경계는 가까운 칸으로 잡히고 중앙 잔량·가격 열은 잡히지 않는다", () => {
  expect(findNearestOrderCell(cells, 9, 112)).toEqual({ side: "sell", price: 70_200, rowKey: "ask:70200" });
  expect(findNearestOrderCell(cells, 78, 136)).toEqual({ side: "sell", price: 70_100, rowKey: "ask:70100" });
  expect(findNearestOrderCell(cells, 342, 112)).toEqual({ side: "buy", price: 70_200, rowKey: "bid:70200" });
  expect(findNearestOrderCell(cells, 411, 136)).toEqual({ side: "buy", price: 70_100, rowKey: "bid:70100" });

  expect(findNearestOrderCell(cells, 200, 112)).toBeNull();
  expect(findNearestOrderCell(cells, 80, 112)).toBeNull();
  expect(findNearestOrderCell(cells, 340, 112)).toBeNull();
  expect(findNearestOrderCell(cells, 5, 112)).toBeNull();
  expect(findNearestOrderCell(cells, 415, 112)).toBeNull();
});

test("사다리 위아래 끝 4px 경계는 첫·마지막 칸을 고르고 멀리 떨어진 빈 자리는 고르지 않는다", () => {
  expect(findNearestOrderCell(cells, 40, 97)?.price).toBe(70_200);
  expect(findNearestOrderCell(cells, 40, 151)?.price).toBe(70_100);
  expect(findNearestOrderCell(cells, 40, 95)).toBeNull();
  expect(findNearestOrderCell(cells, 40, 153)).toBeNull();
});
