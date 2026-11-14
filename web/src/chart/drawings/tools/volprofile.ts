import type { Bar } from "../../../api/generated/Bar";
import { PERIOD_LABEL } from "../../../lib/symbol";
import type { FineBarsRead } from "../finePeriod";
import { at, readBool, readFill, readNumber, readRecord, readStroke, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, Stroke } from "../types";
import { loadedBarsIn } from "./avwap";

export interface VolProfileStyle {
  v: 1;
  rows: number;
  widthPercent: number;
  valuePercent: number;
  bars: Fill;
  valueArea: Fill;
  poc: boolean;
  pocLine: Stroke;
  pocLabel: boolean;
  basisLabel: boolean;
}

export const ROWS = { min: 5, max: 100, step: 1 } as const;
export const PERCENT = { min: 10, max: 100, step: 1, unit: "%" } as const;

export const volProfileDefaults = (): VolProfileStyle => ({
  v: 1,
  rows: 24,
  widthPercent: 40,
  valuePercent: 70,
  bars: { on: true, color: "#787b86", opacity: 0.35 },
  valueArea: { on: true, color: "#2962ff", opacity: 0.45 },
  poc: true,
  pocLine: { color: "#f23645", width: 2, dash: "solid" },
  pocLabel: true,
  basisLabel: true,
});

const whole = (raw: unknown, fallback: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, Math.round(readNumber(raw, fallback))));

export function parseVolProfileStyle(raw: unknown): VolProfileStyle {
  const d = volProfileDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    rows: whole(o.rows, d.rows, ROWS),
    widthPercent: whole(o.widthPercent, d.widthPercent, PERCENT),
    valuePercent: whole(o.valuePercent, d.valuePercent, PERCENT),
    bars: readFill(o.bars, d.bars),
    valueArea: readFill(o.valueArea, d.valueArea),
    poc: readBool(o.poc, d.poc),
    pocLine: readStroke(o.pocLine, d.pocLine),
    pocLabel: readBool(o.pocLabel, d.pocLabel),
    basisLabel: readBool(o.basisLabel, d.basisLabel),
  };
}

export interface Profile {
  low: number;
  step: number;
  rows: number[];
  poc: number;
  valueArea: { from: number; to: number };
}

export const rowLow = (p: Profile, i: number) => p.low + i * p.step;
export const pocPrice = (p: Profile) => rowLow(p, p.poc + 0.5);

const RATIO_TOLERANCE = 1e-12;
const ROW_EDGE_TOLERANCE = 1e-9;

export function volumeProfile(bars: readonly Bar[], rowCount: number, valueShare: number): Profile | null {
  if (bars.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  let total = 0;
  for (const bar of bars) {
    low = Math.min(low, bar.l);
    high = Math.max(high, bar.h);
    total += bar.v;
  }
  if (!(total > 0)) return null;
  const step = (high - low) / rowCount;
  const rowOf = (price: number) => (step === 0 ? 0 : Math.min(rowCount - 1, Math.floor(((price - low) * rowCount) / (high - low) + ROW_EDGE_TOLERANCE)));
  const rows = new Array<number>(rowCount).fill(0);
  for (const bar of bars) {
    const first = rowOf(bar.l);
    const last = rowOf(bar.h);
    if (bar.h === bar.l) {
      rows[first]! += bar.v;
      continue;
    }
    for (let i = first; i <= last; i++) {
      const overlap = Math.min(bar.h, low + (i + 1) * step) - Math.max(bar.l, low + i * step);
      if (overlap > 0) rows[i]! += (bar.v * overlap) / (bar.h - bar.l);
    }
  }
  let poc = 0;
  rows.forEach((v, i) => {
    if (v > rows[poc]!) poc = i;
  });
  let from = poc;
  let to = poc;
  let inside = rows[poc]!;
  const target = valueShare * total * (1 - RATIO_TOLERANCE);
  while (inside < target) {
    const above = rows[to + 1];
    const below = rows[from - 1];
    if (above === undefined && below === undefined) break;
    if (below === undefined || (above !== undefined && above >= below)) inside += rows[++to]!;
    else inside += rows[--from]!;
  }
  return { low, step, rows, poc, valueArea: { from, to } };
}

interface RecentProfile {
  bars: readonly Bar[];
  rows: number;
  valueShare: number;
  profile: Profile | null;
}

const RECENT_PROFILES = 16;
const recentProfiles: RecentProfile[] = [];

const sameBars = (a: readonly Bar[], b: readonly Bar[]) => a.length === b.length && a.every((bar, i) => bar === b[i]);

function recentVolumeProfile(bars: readonly Bar[], rows: number, valueShare: number): Profile | null {
  const index = recentProfiles.findIndex((r) => r.rows === rows && r.valueShare === valueShare && sameBars(r.bars, bars));
  const hit = index < 0 ? { bars, rows, valueShare, profile: volumeProfile(bars, rows, valueShare) } : recentProfiles.splice(index, 1)[0]!;
  recentProfiles.unshift(hit);
  recentProfiles.length = Math.min(recentProfiles.length, RECENT_PROFILES);
  return hit.profile;
}

interface Basis {
  profile: Profile | null;
  label: string;
}

const periodBasis = (period: keyof typeof PERIOD_LABEL) => `${PERIOD_LABEL[period]}봉 기준`;

function basisLabel(read: FineBarsRead, ctx: ToolContext): string {
  const chart = periodBasis(ctx.period);
  switch (read.kind) {
    case "ready":
      return read.bars.length > 0 ? periodBasis(read.period) : chart;
    case "loading":
      return `${chart} · 분봉 받는 중`;
    case "failed":
      return `${chart} · 분봉을 받지 못함`;
    case "none":
      return read.reason === "pastYear" ? `${chart} · 분봉은 최근 1년까지` : chart;
  }
}

const basisOf = (points: readonly DrawingPoint[], style: VolProfileStyle, ctx: ToolContext): Basis => {
  const [p0, p1] = points;
  if (p0 === undefined || p1 === undefined) return { profile: null, label: periodBasis(ctx.period) };
  const chartBars = loadedBarsIn(ctx, p0.t, p1.t);
  const read = ctx.fineBarsIn(p0.t, p1.t);
  const label = basisLabel(read, ctx);
  if (chartBars.length === 0) return { profile: null, label };
  const bars = read.kind === "ready" && read.bars.length > 0 ? read.bars : chartBars;
  return { profile: recentVolumeProfile(bars, style.rows, style.valuePercent / 100), label };
};

const profileOf = (points: readonly DrawingPoint[], style: VolProfileStyle, ctx: ToolContext) => basisOf(points, style, ctx).profile;

const priceSpan = (profile: Profile, ctx: ToolContext) => {
  const top = ctx.yOf(rowLow(profile, profile.rows.length));
  const bottom = ctx.yOf(profile.low);
  return top === null || bottom === null ? null : { top, bottom };
};

const FRAME_OPACITY = 0.05;
const FLAT_BAR_PX = 2;
const BASIS_FONT_PX = 11;
const BASIS_INSET_PX = 4;

const L = at<VolProfileStyle>();

export const volprofile = defineTool<VolProfileStyle>({
  tool: "volprofile",
  group: "measure",
  label: "구간 거래량 프로파일",
  icon: "M4 4 V20 M4 6 H9 M4 9 H14 M4 12 H19 M4 15 H12 M4 18 H7",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "time" },
    { label: "끝", uses: "time" },
  ],
  defaultStyle: volProfileDefaults,
  parseStyle: parseVolProfileStyle,
  bar: { fill: L("bars") },
  settings: {
    inputs: [
      { kind: "number", label: "줄 수", ...ROWS, lens: L("rows") },
      { kind: "number", label: "폭 비율", ...PERCENT, lens: L("widthPercent") },
      { kind: "number", label: "값 영역 비율", ...PERCENT, lens: L("valuePercent") },
    ],
    style: [
      { kind: "fill", label: "막대 채움", lens: L("bars") },
      { kind: "fill", label: "값 영역 채움", lens: L("valueArea") },
      { kind: "toggle", label: "POC 선", lens: L("poc") },
      ...strokeFields("POC 선", L("pocLine")),
      { kind: "toggle", label: "POC 가격 라벨", lens: L("pocLabel") },
      { kind: "toggle", label: "계산 기준 라벨", lens: L("basisLabel") },
    ],
  },
  fineRange({ points }) {
    const [p0, p1] = points;
    return p0 === undefined || p1 === undefined ? null : { t1: p0.t, t2: p1.t };
  },
  shapes({ points, style }, ctx) {
    const xs = points.slice(0, 2).flatMap((p) => {
      const x = ctx.xOf(p.t);
      return x === null ? [] : [x];
    });
    const { profile, label } = basisOf(points, style, ctx);
    const span = profile === null ? null : priceSpan(profile, ctx);
    if (profile === null || span === null || xs.length < 2) {
      const edge: Stroke = { color: style.bars.color, width: 1, dash: "dashed" };
      return xs.map((x): Shape => ({ kind: "vline", x, stroke: edge, allPanes: false }));
    }
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const longest = (right - left) * (style.widthPercent / 100);
    const most = profile.rows[profile.poc]!;
    const shapes: Shape[] = [
      { kind: "rect", a: { x: left, y: span.top }, b: { x: right, y: span.bottom }, stroke: { color: style.bars.color, width: 1, dash: "dotted" }, fill: { on: true, color: style.bars.color, opacity: FRAME_OPACITY } },
    ];
    profile.rows.forEach((volume, i) => {
      const inValueArea = i >= profile.valueArea.from && i <= profile.valueArea.to;
      const fill = inValueArea && style.valueArea.on ? style.valueArea : style.bars;
      const y1 = ctx.yOf(rowLow(profile, i));
      const y2 = ctx.yOf(rowLow(profile, i + 1));
      if (volume <= 0 || !fill.on || y1 === null || y2 === null) return;
      const middle = (y1 + y2) / 2;
      const half = (profile.step === 0 ? FLAT_BAR_PX : Math.abs(y1 - y2)) / 2;
      shapes.push({ kind: "rect", a: { x: left, y: middle - half }, b: { x: left + (longest * volume) / most, y: middle + half }, fill });
    });
    const y = ctx.yOf(pocPrice(profile));
    if (style.poc && y !== null) shapes.push({ kind: "segment", a: { x: left, y }, b: { x: right, y }, stroke: style.pocLine });
    if (style.basisLabel) {
      const textStyle = { color: style.bars.color, size: BASIS_FONT_PX, bold: false, italic: false };
      shapes.push({ kind: "text", at: { x: left + BASIS_INSET_PX, y: Math.min(span.top, span.bottom) + BASIS_INSET_PX }, text: label, style: textStyle, align: "left", baseline: "top" });
    }
    return shapes;
  },
  handles({ points, style }, ctx) {
    const profile = profileOf(points, style, ctx);
    const span = profile === null ? null : priceSpan(profile, ctx);
    const y = span === null ? ctx.paneHeight / 2 : (span.top + span.bottom) / 2;
    return points.slice(0, 2).flatMap((p, i) => {
      const x = ctx.xOf(p.t);
      return x === null ? [] : [{ at: { x, y }, move: (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? { ...q, t: to.t } : q)) }];
    });
  },
  axisLabels({ points, style, selected }, ctx) {
    const labels: AxisLabel[] = [];
    const profile = style.pocLabel ? profileOf(points, style, ctx) : null;
    if (profile !== null) labels.push({ axis: "price", value: pocPrice(profile), text: ctx.formatPrice(pocPrice(profile)), color: style.pocLine.color });
    if (selected) for (const p of points) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.bars.color });
    return labels;
  },
});
