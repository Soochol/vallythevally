import { describe, expect, test } from "vitest";
import {
  AXIS_DECIDE_PX,
  constrainAngle45,
  constrainAxis,
  constrainSquare,
  distanceToSegment,
  extendedSegment,
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
    const flat: Shape = { kind: "ellipse", a: { x: 0, y: 0 }, b: { x: 200, y: 10 }, stroke };
    expect(hitShape(flat, { x: 190, y: 5 }, pane)).toBe("line");
    expect(hitShape(flat, { x: 30, y: 5 }, pane)).toBe("line");
    expect(hitShape(flat, { x: 100, y: 15 }, pane)).toBe("line");
    expect(hitShape(flat, { x: 100, y: 17 }, pane)).toBeNull();
    expect(hitShape(flat, { x: 207, y: 5 }, pane)).toBeNull();
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

  test("핸들이 6px 안에 여럿이면 가장 가까운 핸들", () => {
    const thin: HitItem = { id: "thin", z: 1, shapes: [{ kind: "rect", a: { x: 0, y: 0 }, b: { x: 100, y: 4 }, stroke }], handles: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 4 }, { x: 0, y: 4 }] };
    expect(hitTest([thin], { x: 100, y: 3 }, pane)).toEqual({ kind: "handle", id: "thin", index: 2 });
    expect(hitTest([thin], { x: 1, y: 1 }, pane)).toEqual({ kind: "handle", id: "thin", index: 0 });
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

test("두 점이 화면 밖에 있어도 연장해 화면을 지나는 선은 상자로 고른다", () => {
  const offLeft: HitItem = { id: "left", z: 1, shapes: [{ kind: "segment", a: { x: -5000, y: 250 }, b: { x: -4000, y: 250 }, stroke, extend: "right" }], handles: [] };
  const offRight: HitItem = { id: "right", z: 2, shapes: [{ kind: "segment", a: { x: 5000, y: 100 }, b: { x: 6000, y: 100 }, stroke, extend: "both" }], handles: [] };
  expect(hitTest([offLeft], { x: 400, y: 250 }, pane)).toEqual({ kind: "body", id: "left", part: "line" });
  expect(idsInBox([offLeft, offRight], { x: 300, y: 50 }, { x: 500, y: 300 }, pane)).toEqual(["left", "right"]);
});

test("연장한 선분은 방향과 길이에 상관없이 화면 전체를 덮는다", () => {
  const diagonal: HitItem = { id: "diagonal", z: 1, shapes: [{ kind: "segment", a: { x: -5000, y: -5000 }, b: { x: -4999, y: -4999 }, stroke, extend: "right" }], handles: [] };
  const tiny: HitItem = { id: "tiny", z: 2, shapes: [{ kind: "segment", a: { x: 100, y: 200 }, b: { x: 100 + 1e-12, y: 200 }, stroke, extend: "right" }], handles: [] };
  expect(idsInBox([diagonal, tiny], { x: 150, y: 150 }, { x: 250, y: 250 }, pane)).toEqual(["diagonal", "tiny"]);
  const far = extendedSegment({ x: -1e6, y: -1e6 }, { x: -999_999, y: -999_999 }, "right", pane);
  expect(far.b.y).toBeGreaterThanOrEqual(pane.height);
  const back = extendedSegment({ x: 5000, y: 5000 }, { x: 5001, y: 5001 }, "left", pane);
  expect(back.a.x).toBeLessThanOrEqual(0);
  expect(back.b).toEqual({ x: 5001, y: 5001 });
  expect(extendedSegment({ x: 10, y: 10 }, { x: 10, y: 10 }, "both", pane)).toEqual({ a: { x: 10, y: 10 }, b: { x: 10, y: 10 } });
  const point = { kind: "segment", a: { x: 0, y: 200 }, b: { x: 1e-170, y: 200 }, stroke, extend: "right" } as const;
  expect(extendedSegment(point.a, point.b, point.extend, pane)).toEqual({ a: point.a, b: point.b });
  expect(hitShape(point, { x: 400, y: 200 }, pane)).toBeNull();
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
