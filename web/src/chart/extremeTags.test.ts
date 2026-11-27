import { describe, expect, test } from "vitest";
import { extremeChange, placeExtremeLabel } from "./extremeTags";

test("현재가 대비는 현재가에서 최고가·최저가까지의 등락률이다", () => {
  expect(extremeChange(60_000, 50_000, "last")).toBe("+20.00%");
  expect(extremeChange(40_000, 50_000, "last")).toBe("−20.00%");
});

test("고가·저가 대비는 최고가·최저가에서 현재가까지의 등락률이다", () => {
  expect(extremeChange(60_000, 50_000, "extreme")).toBe("−16.67%");
  expect(extremeChange(40_000, 50_000, "extreme")).toBe("+25.00%");
});

test("나누는 값이 0이면 등락률을 적지 않는다", () => {
  expect(extremeChange(60_000, 0, "last")).toBeNull();
  expect(extremeChange(0, 50_000, "extreme")).toBeNull();
  expect(extremeChange(0, 50_000, "last")).toBe("−100.00%");
});

const SURFACE = { paneWidth: 1000, paneHeight: 500, avoid: { left: 20, top: 16, right: 320, bottom: 130 } };

describe("최고·최저 꼬리표 자리", () => {
  test("장애물과 겹치지 않으면 기본 쪽(최고는 우상, 최저는 우하)에 둔다", () => {
    const high = placeExtremeLabel("high", { x: 600, y: 300 }, "최고 70,000", SURFACE);
    const low = placeExtremeLabel("low", { x: 600, y: 300 }, "최저 60,000", SURFACE);
    expect(high.left).toBe(12);
    expect(high.top).toBe(-30);
    expect(high.overlap).toBe(0);
    expect(high.anchorX).toBe(12);
    expect(high.anchorY).toBe(-10);

    expect(low.left).toBe(12);
    expect(low.top).toBe(10);
    expect(low.overlap).toBe(0);
    expect(low.anchorX).toBe(12);
    expect(low.anchorY).toBe(10);
  });

  test("최고 꼬리표가 범례와 겹치면 빈 자리로 옮긴다", () => {
    const placement = placeExtremeLabel("high", { x: 100, y: 140 }, "최고 70,000", SURFACE);
    expect(placement.overlap).toBe(0);
    expect(140 + placement.top).toBeGreaterThanOrEqual(SURFACE.avoid.bottom);
  });

  test("패널 위·아래·좌·우 8px 안쪽에 가둔다", () => {
    const topEdge = placeExtremeLabel("high", { x: 600, y: 10 }, "최고 70,000", SURFACE);
    expect(10 + topEdge.top).toBeGreaterThanOrEqual(8);

    const bottomEdge = placeExtremeLabel("low", { x: 600, y: 498 }, "최저 60,000", SURFACE);
    expect(498 + bottomEdge.top + bottomEdge.height).toBeLessThanOrEqual(492);

    const rightEdge = placeExtremeLabel("high", { x: 960, y: 300 }, "최고 70,000", SURFACE);
    expect(960 + rightEdge.left + rightEdge.width).toBeLessThanOrEqual(992);
  });

  test("우상 후보에 캔들 장애물이 있으면 좌상 빈 공간으로 회피한다", () => {
    const candleObstacle = { left: 605, top: 260, right: 720, bottom: 320 };
    const placement = placeExtremeLabel("high", { x: 600, y: 300 }, "최고 70,000", {
      ...SURFACE,
      obstacles: [candleObstacle],
    });
    expect(placement.overlap).toBe(0);
    expect(placement.left).toBeLessThan(0);
  });

  test("상대 극값 꼬리표 상자와도 겹치지 않게 회피한다", () => {
    const otherBox = { left: 612, top: 310, right: 720, bottom: 330 };
    const placement = placeExtremeLabel("low", { x: 600, y: 300 }, "최저 60,000", SURFACE, otherBox);
    expect(placement.overlap).toBe(0);
    expect(placement.left).toBeLessThan(0);
  });

  test("범례가 없으면 겹침을 따지지 않는다", () => {
    const placement = placeExtremeLabel("high", { x: 100, y: 140 }, "최고 70,000", { ...SURFACE, avoid: null });
    expect(placement.top).toBe(-30);
    expect(placement.overlap).toBe(0);
  });
});
