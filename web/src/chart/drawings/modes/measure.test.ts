import { describe, expect, test } from "vitest";
import { IDLE, step, type Context } from "../interaction";
import { ohlcTag } from "../magnet";
import type { ToolContext } from "../toolSpec";
import { measure, measureShapes } from "./measure";
import { modeOf } from ".";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => t / 10,
  yOf: (p) => 500 - p,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => ({ count: 5, volume: 120_000 }),
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${Math.round(p)}`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};

const baseCtx: Context = {
  tool: null,
  selected: [],
  drawings: [],
  lockAll: false,
  registeredModes: new Set(["demo", "eraser", "measure"]),
  mode: "measure",
  ctx,
  point: (at) => ctx.fromScreen(at),
};

const none = { ctrl: false, alt: false, shift: false };

describe("빠른 측정 모드", () => {
  test("모드 목록에 등록되고 영구 저장 op을 만들지 않는다", () => {
    expect(modeOf("measure")).toBe(measure);
    expect(measure.finish([], false, { ctx, items: [], lockAll: false, panesBottom: 500, scope: { kind: "symbol" }, newId: () => "id" }).ops).toEqual([]);
  });

  test("가격차·등락률·봉수·거래량을 중복 없이 포함한 측정 도형을 만든다", () => {
    const shapes = measureShapes({ t: 1000, price: 100 }, { t: 2000, price: 120 }, ctx);
    expect(shapes.map((s) => s.kind)).toEqual(["rect", "segment", "segment", "text"]);
    const label = shapes.find((s) => s.kind === "text");
    const text = label?.kind === "text" ? label.text : "";
    expect(text).toContain("+20 (+20.00%)");
    expect(text).toContain("5봉");
    expect(text.match(/거래량/g)).toHaveLength(1);
  });

  test("클릭-클릭과 끌기-놓기 모두 측정 결과 상태로 전이하고 Esc로 해제한다", () => {
    const down = step(IDLE, { kind: "down", at: { x: 100, y: 400 }, mods: none, hit: { kind: "empty" } }, baseCtx);
    expect(down.state.kind).toBe("measuring");
    const upClick = step(down.state, { kind: "up", at: { x: 101, y: 400 }, mods: none }, baseCtx);
    expect(upClick.state.kind).toBe("measuring");
    const click2 = step(upClick.state, { kind: "down", at: { x: 200, y: 300 }, mods: none, hit: { kind: "empty" } }, baseCtx);
    expect(click2.state.kind).toBe("measured");
    expect(click2.effects).toEqual([{ kind: "mode", mode: "measure", path: [], action: "measure" }]);
    expect(step(click2.state, { kind: "cancel" }, baseCtx).state).toEqual(IDLE);

    const dragEnd = step(down.state, { kind: "up", at: { x: 200, y: 300 }, mods: none }, baseCtx);
    expect(dragEnd.state.kind).toBe("measured");
  });

  test("ohlcTag는 봉의 시·고·저·종을 구분한다", () => {
    const b = { t: 0, o: 100, h: 120, l: 90, c: 110, v: 10 };
    expect(ohlcTag(b, 120)).toBe("고가");
    expect(ohlcTag(b, 90)).toBe("저가");
    expect(ohlcTag(b, 110)).toBe("종가");
    expect(ohlcTag(b, 100)).toBe("시가");
    expect(ohlcTag(b, 105)).toBeNull();
  });
});
