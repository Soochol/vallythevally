import { describe, expect, test } from "vitest";
import {
  AXIS_DECIDE_PX,
  constrainAngle45,
  constrainAxis,
  constrainSquare,
  distanceToSegment,
  hitShape,
  hitTest,
  type HitItem,
  idsInBox,
  nudge,
} from "./geometry";
import type { Shape } from "./toolSpec";
import type { Fill, Stroke } from "./types";

const pane = { width: 800, height: 400 };
const stroke: Stroke = { color: "$draw", width: 2, dash: "solid" };
const fill: Fill = { on: true, color: "$draw", opacity: 0.2 };
const line = (x1: number, y1: number, x2: number, y2: number): Shape => ({ kind: "segment", a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, stroke });

describe("선 판정은 6px 안", () => {
  test("선분", () => {
    expect(hitShape(line(0, 0, 100, 0), { x: 50, y: 6 }, pane)).toBe("line");
    expect(hitShape(line(0, 0, 100, 0), { x: 50, y: 7 }, pane)).toBeNull();
    expect(hitShape(line(0, 0, 100, 0), { x: 110, y: 0 }, pane)).toBeNull();
  });

  test("연장한 쪽은 끝을 지나도 선이다", () => {
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 }, "right")).toBe(0);
    expect(distanceToSegment({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 300, y: 0 }, "right")).toBe(0);
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: -50, y: 0 }, "right")).toBe(50);
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: -50, y: 0 }, "both")).toBe(0);
  });

  test("수직선", () => {
    expect(hitShape({ kind: "vline", x: 100, stroke, allPanes: false }, { x: 105, y: 300 }, pane)).toBe("line");
  });
});

describe("채운 도형은 안쪽 전체가 몸통이다", () => {
  test("사각형: 테두리는 선, 안은 채움, 채움이 꺼지면 안은 비었다", () => {
    const rect: Shape = { kind: "rect", a: { x: 100, y: 100 }, b: { x: 200, y: 200 }, stroke, fill };
    expect(hitShape(rect, { x: 102, y: 150 }, pane)).toBe("line");
    expect(hitShape(rect, { x: 150, y: 150 }, pane)).toBe("fill");
    expect(hitShape({ ...rect, fill: { ...fill, on: false } }, { x: 150, y: 150 }, pane)).toBeNull();
  });

  test("타원과 원", () => {
    const ellipse: Shape = { kind: "ellipse", a: { x: 0, y: 0 }, b: { x: 200, y: 100 }, stroke, fill };
    expect(hitShape(ellipse, { x: 100, y: 50 }, pane)).toBe("fill");
    expect(hitShape(ellipse, { x: 198, y: 50 }, pane)).toBe("line");
    expect(hitShape(ellipse, { x: 195, y: 95 }, pane)).toBeNull();
    expect(hitShape({ kind: "circle", c: { x: 50, y: 50 }, r: 10, stroke }, { x: 61, y: 50 }, pane)).toBe("line");
  });

  test("닫힌 다각형", () => {
    const tri: Shape = { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }], closed: true, fill };
    expect(hitShape(tri, { x: 50, y: 30 }, pane)).toBe("fill");
    expect(hitShape(tri, { x: 5, y: 90 }, pane)).toBeNull();
  });

  test("글자 상자", () => {
    const text: Shape = {
      kind: "text",
      at: { x: 100, y: 100 },
      text: "abcd",
      style: { color: "$draw", size: 10, bold: false, italic: false },
      align: "left",
      baseline: "top",
    };
    expect(hitShape(text, { x: 110, y: 105 }, pane)).toBe("fill");
    expect(hitShape(text, { x: 90, y: 105 }, pane)).toBeNull();
  });
});

describe("겹쳤을 때: 핸들 > 선 > 채움, 같으면 z가 큰 것", () => {
  const box: HitItem = { id: "box", z: 5, shapes: [{ kind: "rect", a: { x: 0, y: 0 }, b: { x: 200, y: 200 }, fill }], handles: [] };
  const low: HitItem = { id: "low", z: 1, shapes: [line(0, 100, 200, 100)], handles: [] };
  const high: HitItem = { id: "high", z: 2, shapes: [line(0, 102, 200, 102)], handles: [] };

  test("선이 위의 채움을 이긴다", () => {
    expect(hitTest([box, low], { x: 50, y: 100 }, pane)).toEqual({ kind: "body", id: "low", part: "line" });
  });

  test("같은 선끼리는 z가 큰 것", () => {
    expect(hitTest([high, low], { x: 50, y: 101 }, pane)).toEqual({ kind: "body", id: "high", part: "line" });
    expect(hitTest([low, high], { x: 50, y: 101 }, pane)).toEqual({ kind: "body", id: "high", part: "line" });
  });

  test("고른 드로잉의 핸들이 선을 이긴다", () => {
    const selected: HitItem = { ...low, z: 0, handles: [{ x: 50, y: 104 }] };
    expect(hitTest([high, selected], { x: 50, y: 101 }, pane)).toEqual({ kind: "handle", id: "low", index: 0 });
  });

  test("아무것도 없으면 빈 곳", () => {
    expect(hitTest([low], { x: 50, y: 300 }, pane)).toEqual({ kind: "empty" });
  });
});

test("상자 고르기는 상자에 걸친 드로잉", () => {
  const a: HitItem = { id: "a", z: 1, shapes: [line(10, 10, 50, 50)], handles: [] };
  const b: HitItem = { id: "b", z: 2, shapes: [line(300, 300, 350, 350)], handles: [] };
  expect(idsInBox([a, b], { x: 40, y: 0 }, { x: 0, y: 40 }, pane)).toEqual(["a"]);
});

describe("Shift 제약", () => {
  test("45° 배수, 화면 픽셀 기준", () => {
    const p = constrainAngle45({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(p.x).toBeCloseTo(95, 9);
    expect(p.y).toBeCloseTo(95, 9);
    const h = constrainAngle45({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(h.x).toBeCloseTo(100, 9);
    expect(h.y).toBeCloseTo(0, 9);
  });

  test("정사각형", () => {
    expect(constrainSquare({ x: 10, y: 10 }, { x: 40, y: -10 })).toEqual({ x: 40, y: -20 });
  });

  test("수평·수직은 처음 8px 움직인 방향으로 정한다", () => {
    expect(constrainAxis("undecided", { x: 5, y: 3 })).toEqual({ lock: "undecided", delta: { x: 0, y: 0 } });
    expect(constrainAxis("undecided", { x: AXIS_DECIDE_PX, y: 2 })).toEqual({ lock: "horizontal", delta: { x: AXIS_DECIDE_PX, y: 0 } });
    expect(constrainAxis("horizontal", { x: 3, y: 50 })).toEqual({ lock: "horizontal", delta: { x: 3, y: 0 } });
    expect(constrainAxis("undecided", { x: 1, y: -9 })).toEqual({ lock: "vertical", delta: { x: 0, y: -9 } });
  });
});

describe("화살표 키", () => {
  const ctx = {
    shiftBars: (t: number, n: number) => (t + n * 60 < 0 ? null : t + n * 60),
    price: { toY: (p: number) => 1000 - p * 2, toPrice: (y: number) => (1000 - y) / 2 },
  };
  const points = [
    { t: 60, price: 100 },
    { t: 120, price: 200 },
  ];

  test("←→는 1봉", () => {
    expect(nudge(points, "ArrowRight", ctx)).toEqual([
      { t: 120, price: 100 },
      { t: 180, price: 200 },
    ]);
  });

  test("↑↓는 1px만큼의 가격", () => {
    expect(nudge(points, "ArrowUp", ctx)).toEqual([
      { t: 60, price: 100.5 },
      { t: 120, price: 200.5 },
    ]);
  });

  test("한 점이라도 못 옮기면 옮기지 않는다", () => {
    expect(nudge([{ t: 0, price: 1 }], "ArrowLeft", ctx)).toBeNull();
  });
});
