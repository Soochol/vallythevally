import type { Bar } from "../../../api/generated/Bar";
import { at, DOWN, readBool, readNumber, readOneOf, readRecord, readString, select, UP } from "../styleKit";
import { defineTool, type Lens, type Shape } from "../toolSpec";
import type { Color, DrawingPoint } from "../types";

export type PatternScaleMode = "percent" | "price";
const SCALE_MODES: readonly PatternScaleMode[] = ["percent", "price"];
const SCALE_OPTIONS: readonly { value: PatternScaleMode; label: string }[] = [
  { value: "percent", label: "비율 유지 (%)" },
  { value: "price", label: "가격폭 유지" },
];

export interface BarsPatternStyle {
  v: 1;
  upColor: Color;
  downColor: Color;
  opacity: number;
  scaleMode: PatternScaleMode;
  mirrored: boolean;
  flipped: boolean;
  showSource: boolean;
}

export const barsPatternDefaults = (): BarsPatternStyle => ({
  v: 1,
  upColor: UP,
  downColor: DOWN,
  opacity: 0.45,
  scaleMode: "percent",
  mirrored: false,
  flipped: false,
  showSource: true,
});

export function parseBarsPatternStyle(raw: unknown): BarsPatternStyle {
  const d = barsPatternDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    upColor: readString(o.upColor, d.upColor),
    downColor: readString(o.downColor, d.downColor),
    opacity: Math.round(Math.min(0.95, Math.max(0.1, readNumber(o.opacity, d.opacity))) * 100) / 100,
    scaleMode: readOneOf(o.scaleMode, SCALE_MODES, d.scaleMode),
    mirrored: readBool(o.mirrored, d.mirrored),
    flipped: readBool(o.flipped, d.flipped),
    showSource: readBool(o.showSource, d.showSource),
  };
}

const MAX_GHOST_BARS = 240;

function sampleBars(bars: readonly Bar[]): readonly Bar[] {
  if (bars.length <= MAX_GHOST_BARS) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < MAX_GHOST_BARS; i++) {
    out.push(bars[Math.floor((i * (bars.length - 1)) / (MAX_GHOST_BARS - 1))]!);
  }
  return out;
}

export function projectPrice(value: number, base: number, anchor: number, mode: PatternScaleMode, mirrored: boolean): number {
  if (mode === "percent" && base > 0) {
    const ratio = value / base;
    return mirrored ? anchor * (2 - ratio) : anchor * ratio;
  }
  const diff = value - base;
  return mirrored ? anchor - diff : anchor + diff;
}

const L = at<BarsPatternStyle>();
const opacityPercent: Lens<BarsPatternStyle, number> = {
  get: (s) => Math.round(s.opacity * 100),
  set: (s, v) => ({ ...s, opacity: Math.round(Math.min(95, Math.max(10, v))) / 100 }),
};
const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));

export const barspattern = defineTool<BarsPatternStyle>({
  tool: "barspattern",
  group: "pattern",
  label: "봉 패턴",
  icon: "M5 17 V9 M5 12 H7 V15 H5 M10 15 V6 M10 8 H12 V13 H10 M15 18 V10 M15 12 H17 V16 H15 M19 14 V5 M19 7 H21 V11 H19",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "원본 시작", uses: "both" },
    { label: "원본 끝", uses: "both" },
    { label: "복제 시작", uses: "both" },
  ],
  defaultStyle: barsPatternDefaults,
  parseStyle: parseBarsPatternStyle,
  bar: { lineColor: L("upColor"), lineOpacity: L("opacity") },
  settings: {
    inputs: [
      select("투영 방식", SCALE_OPTIONS, L("scaleMode")),
      { kind: "toggle", label: "상하 반전", lens: L("mirrored") },
      { kind: "toggle", label: "좌우 반전", lens: L("flipped") },
      { kind: "toggle", label: "원본 구간 표시", lens: L("showSource") },
    ],
    style: [
      { kind: "color", label: "양봉 색", lens: L("upColor") },
      { kind: "color", label: "음봉 색", lens: L("downColor") },
      { kind: "number", label: "투명도", min: 10, max: 95, step: 5, unit: "%", lens: opacityPercent },
    ],
  },
  shapes({ points, style, selected }, ctx) {
    const [p0, p1, p2] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    if (p0 === undefined || p1 === undefined || a === null || b === null) return [];
    const c = p2 === undefined ? null : ctx.toScreen(p2);
    if (p2 === undefined || c === null) {
      return [
        {
          kind: "rect",
          a,
          b,
          stroke: { color: style.upColor, width: 1, dash: "dashed" },
          fill: { on: true, color: style.upColor, opacity: 0.12 },
        },
      ];
    }
    const tLo = Math.min(p0.t, p1.t);
    const tHi = Math.max(p0.t, p1.t);
    const rawBars = ctx.barsIn(tLo, tHi);
    const shapes: Shape[] = [];
    if (selected || style.showSource) {
      shapes.push({
        kind: "segment",
        a,
        b,
        stroke: { color: style.upColor, width: 1, dash: "dotted", opacity: Math.min(1, style.opacity + 0.2) },
      });
    }
    if (rawBars.length === 0) {
      shapes.push(
        { kind: "segment", a: b, b: c, stroke: { color: style.upColor, width: 1, dash: "dashed", opacity: Math.min(1, style.opacity + 0.25) } },
        { kind: "circle", c, r: 4, stroke: { color: style.upColor, width: 1, dash: "solid" }, fill: { on: true, color: style.upColor, opacity: style.opacity } },
      );
      return shapes;
    }
    const ordered = sampleBars(style.flipped ? [...rawBars].reverse() : rawBars);
    const firstBar = ordered[0]!;
    const base = firstBar.o > 0 ? firstBar.o : firstBar.c;
    const xs = ordered.map((_, i) => {
      const ti = ctx.shiftBars(p2.t, i);
      return ti === null ? null : ctx.xOf(ti);
    });
    const x0 = xs[0];
    const x1 = xs[1];
    const firstStep = x0 != null && x1 != null ? Math.abs(x1 - x0) : 8;
    const halfWidth = Math.min(8, Math.max(1.5, firstStep * 0.32));
    const edgeOpacity = Math.min(1, style.opacity + 0.25);

    ordered.forEach((bar, i) => {
      const x = xs[i];
      if (x === null || x === undefined) return;
      const yO = ctx.yOf(projectPrice(bar.o, base, p2.price, style.scaleMode, style.mirrored));
      const yH = ctx.yOf(projectPrice(bar.h, base, p2.price, style.scaleMode, style.mirrored));
      const yL = ctx.yOf(projectPrice(bar.l, base, p2.price, style.scaleMode, style.mirrored));
      const yC = ctx.yOf(projectPrice(bar.c, base, p2.price, style.scaleMode, style.mirrored));
      if (yO === null || yH === null || yL === null || yC === null) return;
      const bullish = style.mirrored ? bar.c < bar.o : bar.c >= bar.o;
      const color = bullish ? style.upColor : style.downColor;
      shapes.push(
        {
          kind: "segment",
          a: { x, y: yH },
          b: { x, y: yL },
          stroke: { color, width: 1, dash: "solid", opacity: edgeOpacity },
        },
        {
          kind: "rect",
          a: { x: x - halfWidth, y: yO },
          b: { x: x + halfWidth, y: Math.abs(yC - yO) < 1 ? yO + 1 : yC },
          stroke: { color, width: 1, dash: "solid", opacity: edgeOpacity },
          fill: { on: true, color, opacity: style.opacity },
        },
      );
    });
    return shapes;
  },
  handles({ points }, ctx) {
    const [p0, p1, p2] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    if (a === null || b === null) return [];
    const c = p2 === undefined ? null : ctx.toScreen(p2);
    return [
      { at: a, move: replace(0) },
      { at: b, move: replace(1) },
      ...(c === null ? [] : [{ at: c, move: replace(2) }]),
    ];
  },
  axisLabels: () => [],
});
