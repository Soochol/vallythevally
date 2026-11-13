import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { long, positionDefaults, riskReward, short } from "./position";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = positionDefaults();
const place = (tool: typeof long, at: DrawingPoint) => {
  if (tool.placement.kind !== "points" || tool.placement.oneClick === undefined) throw new Error("not one-click");
  return tool.placement.oneClick(at, ctx);
};
const handleMove = (tool: typeof long, points: DrawingPoint[], index: number, to: DrawingPoint) => {
  const handle = tool.handles({ points, style, text: null, selected: true }, ctx)[index];
  if (handle === undefined) throw new Error(`no handle ${index}`);
  return handle.move(points, to, ctx);
};
const texts = (tool: typeof long, points: DrawingPoint[]) =>
  tool.shapes({ points, style, text: null, selected: false }, ctx).flatMap((s) => (s.kind === "text" ? [s.text] : []));

describe("매수 포지션", () => {
  const entry = { t: 1000, price: 200 };
  const points = place(long, entry);

  test("한 번 누르면 진입, +10% 목표와 20봉 뒤 오른쪽 끝, −5% 손절의 세 점이 된다", () => {
    expect(long.placement).toMatchObject({ kind: "points", count: 3 });
    expect(points).toEqual([entry, { t: 1000 + 20 * 60, price: 220.00000000000003 }, { t: 1000, price: 190 }]);
  });

  test("목표 띠는 $up, 손절 띠는 $down이고, 변화율과 손익비를 늘 적는다", () => {
    const shapes = long.shapes({ points, style, text: null, selected: false }, ctx);
    expect(shapes.filter((s) => s.kind === "rect").map((s) => s.kind === "rect" && s.fill?.color)).toEqual(["$up", "$down"]);
    expect(texts(long, [entry, { t: 2200, price: 230 }, { t: 1000, price: 185 }])).toEqual(["목표 230 (+15.00%)", "손절 185 (−7.50%)", "손익비 2.00"]);
  });

  test("손익비는 목표 폭 ÷ 손절 폭이고, 손절 폭이 0이면 적지 않는다", () => {
    expect(riskReward(100, 130, 90)).toBe(3);
    expect(riskReward(100, 70, 110)).toBe(3);
    expect(riskReward(100, 130, 100)).toBeNull();
    expect(texts(long, [entry, { t: 2200, price: 220 }, entry]).some((t) => t.startsWith("손익비"))).toBe(false);
  });

  test("핸들은 목표가, 손절가, 오른쪽 끝, 진입 점 순서다", () => {
    expect(long.handles({ points, style, text: null, selected: true }, ctx).map((h) => h.at)).toEqual([
      { x: 100, y: 500 - points[1]!.price },
      { x: 100, y: 310 },
      { x: 220, y: 300 },
      { x: 100, y: 300 },
    ]);
  });

  test("목표가는 진입가 아래로, 손절가는 진입가 위로 넘어가지 않는다", () => {
    expect(handleMove(long, points, 0, { t: 0, price: 250 })[1]).toEqual({ t: 2200, price: 250 });
    expect(handleMove(long, points, 0, { t: 0, price: 150 })[1]).toEqual({ t: 2200, price: 200 });
    expect(handleMove(long, points, 1, { t: 0, price: 180 })[2]).toEqual({ t: 1000, price: 180 });
    expect(handleMove(long, points, 1, { t: 0, price: 260 })[2]).toEqual({ t: 1000, price: 200 });
  });

  test("오른쪽 끝은 시각만, 진입 점은 손절가와 목표가 사이에서 움직인다", () => {
    expect(handleMove(long, points, 2, { t: 5000, price: 1 })).toEqual([entry, { t: 5000, price: points[1]!.price }, points[2]]);
    expect(handleMove(long, points, 3, { t: 1500, price: 400 })[0]).toEqual({ t: 1500, price: points[1]!.price });
    expect(handleMove(long, points, 3, { t: 9000, price: 1 })[0]).toEqual({ t: 2200, price: 190 });
  });

  test("점이 모자라거나 화면에 못 놓으면 던지지 않는다", () => {
    expect(long.shapes({ points: [entry], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(long.shapes({ points: [{ t: -1, price: 1 }, ...points.slice(1)], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(long.shapes({ points: points.slice(0, 2), style, text: null, selected: false }, ctx).filter((s) => s.kind === "rect")).toHaveLength(1);
    expect(long.handles({ points: points.slice(0, 2), style, text: null, selected: true }, ctx)).toEqual([]);
  });
});

describe("매도 포지션", () => {
  const entry = { t: 1000, price: 200 };
  const points = place(short, entry);

  test("목표는 진입가 아래 −10%, 손절은 위 +5%다", () => {
    expect(points.map((p) => Math.round(p.price))).toEqual([200, 180, 210]);
    expect(texts(short, points)).toEqual(["목표 180 (−10.00%)", "손절 210 (+5.00%)", "손익비 2.00"]);
  });

  test("목표가는 진입가 위로, 손절가는 진입가 아래로 넘어가지 않는다", () => {
    expect(handleMove(short, points, 0, { t: 0, price: 230 })[1]?.price).toBe(200);
    expect(handleMove(short, points, 0, { t: 0, price: 170 })[1]?.price).toBe(170);
    expect(handleMove(short, points, 1, { t: 0, price: 150 })[2]?.price).toBe(200);
    expect(handleMove(short, points, 1, { t: 0, price: 220 })[2]?.price).toBe(220);
  });
});

test("포지션 스타일: 글자 색 막대, 모르는 키 보존, 틀린 값은 기본값", () => {
  expect(long.bar).toMatchObject({ fill: undefined, lineColor: undefined });
  expect(long.parseStyle(long.bar.textColor?.set(style, "#ffffff"))).toMatchObject({ label: { color: "#ffffff" } });
  expect(short.parseStyle({ v: 2, extra: 1, profit: { opacity: -1 }, stop: "x" })).toMatchObject({ v: 1, extra: 1, profit: { on: true, color: "$up", opacity: 0 }, stop: style.stop });
});
