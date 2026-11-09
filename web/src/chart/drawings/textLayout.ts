import type { Shape } from "./toolSpec";
import type { ScreenPoint, TextStyle } from "./types";

type TextShape = Extract<Shape, { kind: "text" }>;
export interface TextBox { x1: number; y1: number; x2: number; y2: number }
export type TextMeasure = (text: string, style: TextStyle) => { width: number; height: number; ink?: TextBox };
export interface TextLayout {
  font: string;
  lines: readonly { text: string; x: number; y: number }[];
  box: TextBox;
  bounds: TextBox;
}

const prepared = new WeakMap<TextShape, TextLayout>();

export function textFont(style: TextStyle): string {
  return `${style.italic ? "italic " : ""}${style.bold ? "600 " : ""}${style.size}px Pretendard, sans-serif`;
}

export const approxTextMeasure: TextMeasure = (text, style) => ({ width: [...text].length * style.size * 0.6, height: style.size * 1.2 });

function union(a: TextBox, b: TextBox): TextBox {
  return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
}

export function layoutText(shape: TextShape, measure: TextMeasure): TextLayout {
  const measured = new Map<string, ReturnType<TextMeasure>>();
  const metrics = (text: string) => {
    const previous = measured.get(text);
    if (previous) return previous;
    const value = measure(text, shape.style); measured.set(text, value); return value;
  };
  const wrapWidth = shape.box?.wrapWidth;
  const rows = shape.text.split("\n").flatMap((line) => {
    if (!wrapWidth || wrapWidth <= 0) return [line];
    const wrapped: string[] = []; let row = "";
    for (const letter of line) {
      if (row && metrics(row + letter).width > wrapWidth) { wrapped.push(row); row = ""; }
      row += letter;
    }
    return [...wrapped, row];
  });
  const width = Math.max(0, ...rows.map((line) => metrics(line).width));
  const lineHeight = shape.style.size * 1.2;
  const height = rows.length * lineHeight;
  const x = shape.align === "center" ? -width / 2 : shape.align === "right" ? -width : 0;
  const y = shape.baseline === "middle" ? -height / 2 : shape.baseline === "bottom" ? -height : 0;
  const pad = shape.box?.padding ?? 0;
  const box = { x1: x - pad, y1: y - pad, x2: x + width + pad, y2: y + height + pad };
  const border = (shape.box?.border?.width ?? 0) / 2;
  let bounds = { x1: box.x1 - border, y1: box.y1 - border, x2: box.x2 + border, y2: box.y2 + border };
  const lines = rows.map((text, index) => {
    const line = { text, x, y: y + index * lineHeight };
    const m = metrics(text);
    const ink = m.ink ?? { x1: 0, y1: 0, x2: m.width, y2: m.height };
    bounds = union(bounds, { x1: line.x + ink.x1, y1: line.y + ink.y1, x2: line.x + ink.x2, y2: line.y + ink.y2 });
    return line;
  });
  return { font: textFont(shape.style), lines, box, bounds };
}

export function prepareText(shape: TextShape, measure: TextMeasure): TextShape {
  const copy = { ...shape };
  prepared.set(copy, layoutText(copy, measure));
  return copy;
}

export function textLayout(shape: TextShape, measure: TextMeasure = approxTextMeasure): TextLayout {
  return prepared.get(shape) ?? layoutText(shape, measure);
}

export function textBounds(shape: TextShape, layout: TextLayout): TextBox {
  const b = layout.bounds;
  return shape.orientation === "vertical"
    ? { x1: shape.at.x + b.y1, y1: shape.at.y - b.x2, x2: shape.at.x + b.y2, y2: shape.at.y - b.x1 }
    : { x1: shape.at.x + b.x1, y1: shape.at.y + b.y1, x2: shape.at.x + b.x2, y2: shape.at.y + b.y2 };
}

export function textLocalPoint(shape: TextShape, point: ScreenPoint): ScreenPoint {
  const x = point.x - shape.at.x; const y = point.y - shape.at.y;
  return shape.orientation === "vertical" ? { x: -y, y: x } : { x, y };
}
