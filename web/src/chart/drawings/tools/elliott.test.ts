import { describe, expect, test } from "vitest";
import type { Tool, ToolContext } from "../toolSpec";
import { elliott, elliottabc } from "./elliott";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  barsIn: () => [],
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const wave = (count: number) => Array.from({ length: count }, (_, i) => ({ t: 1000 * (i + 1), price: i % 2 === 0 ? 100 + i * 10 : 300 + i * 10 }));
const marks = (tool: Tool, form: string, count: number) =>
  tool.shapes({ points: wave(count), style: tool.parseStyle({ ...(tool.defaultStyle() as object), form }), text: null, selected: false }, ctx).flatMap((s) => (s.kind === "text" ? [s.text] : []));

describe("엘리엇 충격 파동", () => {
  test("점 여섯을 찍는다", () => {
    expect(elliott.placement).toEqual({ kind: "points", count: 6 });
  });

  test("꼬리표 모양 셋의 글자", () => {
    expect(marks(elliott, "number", 6)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(marks(elliott, "paren", 6)).toEqual(["(0)", "(1)", "(2)", "(3)", "(4)", "(5)"]);
    expect(marks(elliott, "roman", 6)).toEqual(["0", "i", "ii", "iii", "iv", "v"]);
  });

  test("기본은 숫자이고 모르는 모양은 숫자로 읽는다", () => {
    expect(elliott.parseStyle({ form: "greek", future: 1 })).toMatchObject({ v: 1, form: "number", future: 1 });
    const field = elliott.settings.text?.find((f) => f.kind === "select");
    expect(field?.kind === "select" && field.options.map((o) => o.value)).toEqual(["number", "paren", "roman"]);
  });
});

describe("엘리엇 조정 파동", () => {
  test("점 넷을 찍는다", () => {
    expect(elliottabc.placement).toEqual({ kind: "points", count: 4 });
  });

  test("꼬리표 모양 셋의 글자", () => {
    expect(marks(elliottabc, "upper", 4)).toEqual(["0", "A", "B", "C"]);
    expect(marks(elliottabc, "paren", 4)).toEqual(["(0)", "(A)", "(B)", "(C)"]);
    expect(marks(elliottabc, "lower", 4)).toEqual(["0", "a", "b", "c"]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    expect(elliottabc.parseStyle({ v: 7, form: 3, future: true, line: { width: 0 }, labels: { size: 1000 } })).toEqual({
      ...(elliottabc.defaultStyle() as object),
      future: true,
      labels: { ...(elliottabc.defaultStyle() as { labels: object }).labels, size: 72 },
    });
  });
});
