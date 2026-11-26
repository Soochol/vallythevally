import { at, defaultStroke, readNumber, readRecord, readStroke } from "../styleKit";
import { defineTool, type Lens } from "../toolSpec";
import type { Stroke, Width } from "../types";
import { eraseBrush } from "./brush";
import { visibleVertices } from "./path";

export interface HighlighterStyle {
  v: 1;
  line: Stroke;
}

const HIGHLIGHTER_PIXEL_WIDTH: Readonly<Record<Width, number>> = {
  1: 10,
  2: 14,
  3: 18,
  4: 24,
  5: 30,
};

export const highlighterDefaults = (): HighlighterStyle => ({
  v: 1,
  line: { ...defaultStroke(), color: "$warning", width: 3, opacity: 0.35 },
});

export function parseHighlighterStyle(raw: unknown): HighlighterStyle {
  const d = highlighterDefaults();
  const o = readRecord(raw);
  const line = readStroke(o.line, d.line);
  return {
    ...o,
    v: 1,
    line: {
      ...line,
      dash: "solid",
      opacity: Math.round(Math.min(0.85, Math.max(0.1, readNumber(line.opacity, d.line.opacity ?? 0.35))) * 100) / 100,
    },
  };
}

const L = at<HighlighterStyle>();

const highlighterOpacity: Lens<HighlighterStyle, number> = {
  get: (s) => s.line.opacity ?? 0.35,
  set: (s, v) => ({
    ...s,
    line: { ...s.line, opacity: Math.round(Math.min(0.85, Math.max(0.1, v)) * 100) / 100 },
  }),
};

const opacityPercent: Lens<HighlighterStyle, number> = {
  get: (s) => Math.round((s.line.opacity ?? 0.35) * 100),
  set: (s, v) => highlighterOpacity.set(s, v / 100),
};

export const highlighter = defineTool<HighlighterStyle>({
  tool: "highlighter",
  group: "shape",
  label: "형광펜",
  icon: "M4 18 L14 8 L18 12 L8 22 H4 Z M14 8 L17 5 L21 9 L18 12 M3 21 H21",
  placement: { kind: "freehand", min: 2, max: 1000 },
  defaultStyle: highlighterDefaults,
  parseStyle: parseHighlighterStyle,
  bar: { lineColor: L("line", "color"), lineOpacity: highlighterOpacity, width: L("line", "width") },
  settings: {
    style: [
      { kind: "color", label: "색상", lens: L("line", "color") },
      { kind: "width", label: "굵기", lens: L("line", "width") },
      { kind: "number", label: "불투명도", min: 10, max: 85, step: 5, unit: "%", lens: opacityPercent },
    ],
  },
  shapes({ points, style }, ctx) {
    const trail = visibleVertices(points, ctx).map((v) => v.at);
    if (trail.length < 2) return [];
    return [
      {
        kind: "polyline",
        points: trail,
        closed: false,
        stroke: {
          ...style.line,
          dash: "solid",
          cap: "round",
          pixelWidth: HIGHLIGHTER_PIXEL_WIDTH[style.line.width],
        },
      },
    ];
  },
  handles: () => [],
  axisLabels: () => [],
  eraseAlong: eraseBrush,
});
