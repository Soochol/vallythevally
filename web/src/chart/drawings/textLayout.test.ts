import { describe, expect, test } from "vitest";
import { hitShape, idsInBox, shapeBounds } from "./geometry";
import type { Shape } from "./toolSpec";
import { layoutText, prepareText, textFont, type TextMeasure } from "./textLayout";

const pane = { width: 800, height: 400 };
const shape: Extract<Shape, { kind: "text" }> = { kind: "text", at: { x: 100, y: 100 }, text: "abcd", style: { color: "#000", size: 10, bold: true, italic: true }, align: "left", baseline: "top" };
const measure: TextMeasure = (text) => ({ width: text.length * 10, height: 12, ink: { x1: -3, y1: -2, x2: text.length * 10 + 4, y2: 14 } });

describe("shared text layout", () => {
  test("font includes the same family, weight and italic used for measurement", () => {
    expect(textFont(shape.style)).toBe("italic 600 10px Pretendard, sans-serif");
    expect(layoutText(shape, measure).font).toBe(textFont(shape.style));
  });

  test("wrapping and explicit empty rows determine height before baseline alignment", () => {
    const layout = layoutText({ ...shape, text: "abcde\n\nz", align: "right", baseline: "bottom", box: { padding: 5, wrapWidth: 20 } }, measure);
    expect(layout.lines).toEqual([
      { text: "ab", x: -20, y: -60 }, { text: "cd", x: -20, y: -48 }, { text: "e", x: -20, y: -36 },
      { text: "", x: -20, y: -24 }, { text: "z", x: -20, y: -12 },
    ]);
    expect(layout.box).toEqual({ x1: -25, y1: -65, x2: 5, y2: 5 });
  });

  test("padding extends around the aligned box instead of moving its content", () => {
    const prepared = prepareText({ ...shape, align: "right", baseline: "bottom", box: { padding: 8, wrapWidth: null } }, measure);
    expect(shapeBounds(prepared, pane)).toEqual({ x1: 52, y1: 80, x2: 108, y2: 108 });
    expect(hitShape(prepared, { x: 54, y: 82 }, pane)).toBe("fill");
    expect(hitShape(prepared, { x: 51, y: 82 }, pane)).toBeNull();
  });

  test("ink overhang belongs to hit, bounds and box selection", () => {
    const prepared = prepareText(shape, measure);
    expect(shapeBounds(prepared, pane)).toEqual({ x1: 97, y1: 98, x2: 144, y2: 114 });
    expect(hitShape(prepared, { x: 98, y: 99 }, pane)).toBe("fill");
    expect(idsInBox([{ id: "ink", z: 1, shapes: [prepared], handles: [] }], { x: 97, y: 98 }, { x: 99, y: 99 }, pane)).toEqual(["ink"]);
  });

  test("vertical text rotates the aligned local box and ink around its anchor", () => {
    const prepared = prepareText({ ...shape, orientation: "vertical", align: "center", baseline: "middle" }, measure);
    expect(shapeBounds(prepared, pane)).toEqual({ x1: 92, y1: 76, x2: 108, y2: 123 });
    expect(hitShape(prepared, { x: 93, y: 122 }, pane)).toBe("fill");
    expect(hitShape(prepared, { x: 91, y: 122 }, pane)).toBeNull();
  });

  test("prepared geometry reuses measurements even when supplied a different measure", () => {
    const calls: string[] = [];
    const prepared = prepareText({ ...shape, text: "aaaa", box: { padding: 0, wrapWidth: 20 } }, (text, style) => { calls.push(text); return measure(text, style); });
    expect(calls.filter((text) => text === "aa")).toHaveLength(1);
    const fail: TextMeasure = () => { throw new Error("prepared layout must not be measured again"); };
    expect(shapeBounds(prepared, pane, fail).y2).toBe(126);
    expect(hitShape(prepared, { x: 100, y: 124 }, pane, fail)).toBe("fill");
  });
});
