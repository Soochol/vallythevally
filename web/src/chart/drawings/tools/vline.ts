import { at, defaultStroke, defaultText, readBool, readOneOf, readRecord, readStroke, readTextStyle, select, strokeFields } from "../styleKit";
import { defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { Stroke, TextStyle } from "../types";

type Orientation = "horizontal" | "vertical";
type VAlign = "top" | "middle" | "bottom";

export interface VLineStyle {
  v: 1;
  line: Stroke;
  allPanes: boolean;
  timeLabel: boolean;
  label: TextStyle & { orientation: Orientation; vAlign: VAlign };
}

const ORIENTATIONS: readonly Orientation[] = ["horizontal", "vertical"];
const VALIGNS: readonly VAlign[] = ["top", "middle", "bottom"];

export const vlineDefaults = (): VLineStyle => ({
  v: 1,
  line: defaultStroke(),
  allPanes: true,
  timeLabel: true,
  label: { ...defaultText(), orientation: "vertical", vAlign: "bottom" },
});

export function parseVLineStyle(raw: unknown): VLineStyle {
  const d = vlineDefaults();
  const o = readRecord(raw);
  const label = readRecord(o.label);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    allPanes: readBool(o.allPanes, d.allPanes),
    timeLabel: readBool(o.timeLabel, d.timeLabel),
    label: {
      ...readTextStyle(o.label, d.label),
      orientation: readOneOf(label.orientation, ORIENTATIONS, d.label.orientation),
      vAlign: readOneOf(label.vAlign, VALIGNS, d.label.vAlign),
    },
  };
}

const TEXT_GAP = 4;
const ALONG_VERTICAL: Record<VAlign, "left" | "center" | "right"> = { top: "right", middle: "center", bottom: "left" };

function labelShape(style: VLineStyle, text: string, x: number, ctx: ToolContext): Shape {
  const { orientation, vAlign } = style.label;
  const y = vAlign === "top" ? TEXT_GAP : vAlign === "middle" ? ctx.paneHeight / 2 : ctx.paneHeight - TEXT_GAP;
  return orientation === "vertical"
    ? { kind: "text", at: { x: x - TEXT_GAP, y }, text, style: style.label, align: ALONG_VERTICAL[vAlign], baseline: "bottom", orientation }
    : { kind: "text", at: { x: x + TEXT_GAP, y }, text, style: style.label, align: "left", baseline: vAlign };
}

const L = at<VLineStyle>();

export const vline = defineTool<VLineStyle>({
  tool: "vline",
  group: "line",
  label: "수직선",
  icon: "M12 3 V21",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "시각", uses: "time" }],
  text: { editOnPlace: false },
  defaultStyle: vlineDefaults,
  parseStyle: parseVLineStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "모든 패널에 긋기", lens: L("allPanes") },
      { kind: "toggle", label: "시간 라벨", lens: L("timeLabel") },
    ],
    text: [
      { kind: "text", label: "글자", multiline: false },
      {
        kind: "textStyle",
        label: "글자 모양",
        lens: { get: (s) => s.label, set: (s, v) => ({ ...s, label: { ...s.label, ...v } }) },
      },
      select(
        "글자 방향",
        [
          { value: "horizontal", label: "가로" },
          { value: "vertical", label: "세로" },
        ],
        L("label", "orientation"),
      ),
      select(
        "세로 정렬",
        [
          { value: "top", label: "위" },
          { value: "middle", label: "가운데" },
          { value: "bottom", label: "아래" },
        ],
        L("label", "vAlign"),
      ),
    ],
  },
  shapes({ points, style, text }, ctx) {
    const p = points[0];
    const x = p === undefined ? null : ctx.xOf(p.t);
    if (x === null) return [];
    const shapes: Shape[] = [{ kind: "vline", x, stroke: style.line, allPanes: style.allPanes }];
    if (text !== null && text !== "") shapes.push(labelShape(style, text, x, ctx));
    return shapes;
  },
  handles({ points }, ctx) {
    const p = points[0];
    const x = p === undefined ? null : ctx.xOf(p.t);
    return x === null ? [] : [{ at: { x, y: ctx.paneHeight / 2 }, move: (pts, to) => pts.map((q) => ({ ...q, t: to.t })) }];
  },
  axisLabels({ points, style }, ctx) {
    const p = points[0];
    if (p === undefined || !style.timeLabel) return [];
    return [{ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color }];
  },
});
