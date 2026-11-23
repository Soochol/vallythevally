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
  test("범례와 겹치지 않으면 기본 쪽(최고는 위, 최저는 아래)에 둔다", () => {
    expect(placeExtremeLabel("high", { x: 600, y: 300 }, "최고 70,000", SURFACE)).toEqual({ flip: false, top: -30 });
    expect(placeExtremeLabel("low", { x: 600, y: 300 }, "최저 60,000", SURFACE)).toEqual({ flip: false, top: 10 });
  });

  test("최고 꼬리표가 범례와 겹치면 아래쪽으로 뒤집는다", () => {
    const placement = placeExtremeLabel("high", { x: 100, y: 140 }, "최고 70,000", SURFACE);
    expect(placement.top).toBe(10);
  });

  test("뒤집어도 패널 위·아래 8px 안쪽에 가둔다", () => {
    expect(placeExtremeLabel("high", { x: 600, y: 10 }, "최고 70,000", SURFACE).top).toBe(-2);
    expect(placeExtremeLabel("low", { x: 600, y: 498 }, "최저 60,000", SURFACE).top).toBe(-26);
  });

  test("오른쪽 가장자리에 가까우면 왼쪽으로 뒤집는다", () => {
    expect(placeExtremeLabel("high", { x: 900, y: 300 }, "최고 70,000", SURFACE).flip).toBe(true);
  });

  test("범례가 없으면 겹침을 따지지 않는다", () => {
    expect(placeExtremeLabel("high", { x: 100, y: 140 }, "최고 70,000", { ...SURFACE, avoid: null }).top).toBe(-30);
  });
});
