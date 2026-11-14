import { describe, expect, test } from "vitest";
import { renderItem } from "../frame";
import type { ToolContext } from "../toolSpec";
import { brush } from "../tools/brush";
import { ellipseDefaults } from "../tools/ellipse";
import { rectDefaults } from "../tools/rect";
import { trendline } from "../tools/trendline";
import { vline, vlineDefaults } from "../tools/vline";
import type { DrawingBody, DrawingOp } from "../types";
import { eraser } from "./eraser";
import { MODES, modeOf, type ModeContext } from ".";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => null, paneWidth: 800, paneHeight: 600,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  formatPrice: String, formatTime: String, logScale: false,
};
const body = (id: string, over: Partial<DrawingBody>): DrawingBody => ({ id, symbol: "005930", tool: "trendline", points: [], text: null,
  style: trendline.defaultStyle(), locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 3, ...over });
const low = body("low", { points: [{ t: 100, price: 100 }, { t: 300, price: 100 }], z: 1 });
const high = body("high", { points: [{ t: 100, price: 100 }, { t: 300, price: 300 }], z: 2 });
const far = body("far", { points: [{ t: 100, price: 500 }, { t: 300, price: 500 }], z: 3 });
const stroke = body("stroke", { tool: "brush", style: brush.defaultStyle(), points: Array.from({ length: 11 }, (_, i) => ({ t: 400 + i * 10, price: 200 })),
  periods: ["D", "W"], group: "메모", scope: { kind: "layout", layoutId: "L" }, z: 4 });

function rendered(d: DrawingBody, selected = false) {
  const item = renderItem(d, selected, ctx);
  if (item === null) throw new Error(`${d.tool} 도구가 등록되지 않았습니다`);
  return item;
}
function created(op: DrawingOp | undefined) {
  if (op?.kind !== "create") throw new Error(`create가 아닌 변경: ${op?.kind}`);
  return op.after;
}

let ids = 0;
const mode = (drawings: DrawingBody[], lockAll = false): ModeContext => ({ ctx, lockAll, panesBottom: 700, scope: { kind: "symbol" },
  items: drawings.map((d) => rendered(d)), newId: () => `new-${++ids}` });
const deleted = (ops: readonly DrawingOp[]) => ops.map((op) => op.kind === "delete" ? op.before.id : `${op.kind}?`);

describe("지우개", () => {
  test("도구 막대에 지우개, 엔진에 시연 커서가 등록된다", () => {
    expect(MODES.map((m) => m.id)).toEqual(["eraser", "demo"]);
    expect(modeOf("eraser")).toBe(eraser);
  });

  test("클릭은 누른 곳에서 가장 위 드로잉 하나만 지운다", () => {
    expect(deleted(eraser.finish([{ x: 100, y: 100 }], false, mode([low, high, far])).ops)).toEqual(["high"]);
    expect(eraser.finish([{ x: 700, y: 50 }], false, mode([low, high, far])).ops).toEqual([]);
  });

  test("클릭은 핸들이나 선이 아래에 있어도 z가 가장 큰 드로잉을 지운다", () => {
    const crossing = body("crossing", { points: [{ t: 300, price: 50 }, { t: 300, price: 150 }], z: 2 });
    const handleUnder: ModeContext = { ...mode([crossing]), items: [rendered(low, true), rendered(crossing)] };
    expect(deleted(eraser.finish([{ x: 300, y: 100 }], false, handleUnder).ops)).toEqual(["crossing"]);
    const box = body("box", { tool: "rect", style: { ...rectDefaults(), fill: { on: true, color: "#fff", opacity: 0.2 } }, points: [{ t: 50, price: 50 }, { t: 350, price: 150 }], z: 5 });
    expect(deleted(eraser.finish([{ x: 200, y: 100 }], false, mode([low, box])).ops)).toEqual(["box"]);
  });

  test("선택한 드로잉은 모양 밖에 있는 핸들을 눌러도 지운다", () => {
    const oval = body("oval", { tool: "ellipse", style: ellipseDefaults(), points: [{ t: 100, price: 100 }, { t: 300, price: 300 }] });
    const selected: ModeContext = { ...mode([]), items: [rendered(oval, true)] };
    expect(deleted(eraser.finish([{ x: 100, y: 100 }], false, selected).ops)).toEqual(["oval"]);
    expect(deleted(eraser.finish([{ x: 100, y: 100 }], false, mode([oval])).ops)).toEqual([]);
  });

  test("끌기는 자취가 지나간 드로잉을 모두 지우고, 빠르게 움직여 듬성한 자취도 사이를 메운다", () => {
    const ops = eraser.finish([{ x: 250, y: 50 }, { x: 250, y: 450 }], false, mode([low, high, far])).ops;
    expect(deleted(ops)).toEqual(["low", "high"]);
    expect(ops).toEqual([{ kind: "delete", before: low }, { kind: "delete", before: high }]);
  });

  test("모든 칸에 그린 수직선은 아래 칸에서 지나가면 지우고, 칸 아래 시간축에서 지나가면 남긴다", () => {
    const line = body("line", { tool: "vline", style: vline.defaultStyle(), points: [{ t: 300, price: 100 }] });
    const below = [{ x: 250, y: 650 }, { x: 350, y: 650 }];
    expect(vline.shapes({ points: line.points, style: line.style, text: null, selected: false }, ctx)).toContainEqual(expect.objectContaining({ kind: "vline", allPanes: true }));
    expect(deleted(eraser.finish(below, false, mode([line, low])).ops)).toEqual(["line"]);
    expect(eraser.finish([{ x: 250, y: 720 }, { x: 350, y: 720 }], false, mode([line])).ops).toEqual([]);
    const onePane = { ...line, style: { ...vlineDefaults(), allPanes: false } };
    expect(eraser.finish(below, false, mode([onePane])).ops).toEqual([]);
  });

  test("잠긴 드로잉과 모든 드로잉 잠그기는 지우지 않는다", () => {
    const locked = { ...high, locked: true };
    expect(eraser.finish([{ x: 100, y: 100 }], false, mode([low, locked])).ops).toEqual([]);
    expect(deleted(eraser.finish([{ x: 250, y: 50 }, { x: 250, y: 450 }], false, mode([low, locked])).ops)).toEqual(["low"]);
    expect(eraser.finish([{ x: 250, y: 50 }, { x: 250, y: 450 }], false, mode([low, high], true)).ops).toEqual([]);
    expect(eraser.finish([{ x: 450, y: 150 }, { x: 450, y: 250 }], true, mode([{ ...stroke, locked: true }])).ops).toEqual([]);
    expect(eraser.finish([{ x: 450, y: 150 }, { x: 450, y: 250 }], true, mode([stroke], true)).ops).toEqual([]);
  });

  test("Ctrl+끌기는 붓 획의 지나간 부분만 지우고 토막은 원래 획의 설정을 물려받는다", () => {
    const ops = eraser.finish([{ x: 450, y: 150 }, { x: 450, y: 250 }], true, mode([stroke, low]));
    expect(ops.ops).toHaveLength(2);
    const [kept, added] = ops.ops;
    expect(kept).toEqual({ kind: "update", before: stroke, after: { ...stroke, points: stroke.points.slice(0, 5) } });
    const { id, points, revision, ...inherited } = created(added);
    const { id: _id, points: _points, revision: _revision, ...original } = stroke;
    expect(id).not.toBe(stroke.id);
    expect(points).toEqual(stroke.points.slice(6));
    expect(revision).toBe(0);
    expect(inherited).toEqual(original);
  });

  test("Ctrl+끌기로 획 전체를 덮으면 획을 지우고, 닿지 않거나 eraseAlong이 없는 도구는 그대로 둔다", () => {
    expect(eraser.finish([{ x: 390, y: 200 }, { x: 510, y: 200 }], true, mode([stroke])).ops).toEqual([{ kind: "delete", before: stroke }]);
    expect(eraser.finish([{ x: 450, y: 400 }, { x: 460, y: 400 }], true, mode([stroke])).ops).toEqual([]);
    expect(eraser.finish([{ x: 200, y: 50 }, { x: 200, y: 150 }], true, mode([low])).ops).toEqual([]);
  });

  test("끄는 동안 자취와 지우개 끝을 미리보기로 그린다", () => {
    const preview = eraser.preview([{ x: 10, y: 10 }, { x: 40, y: 10 }], mode([]));
    expect(preview.map((s) => s.kind)).toEqual(["polyline", "circle"]);
    expect(eraser.preview([{ x: 10, y: 10 }], mode([])).map((s) => s.kind)).toEqual(["circle"]);
  });
});
