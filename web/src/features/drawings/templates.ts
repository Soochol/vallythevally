import { drawingColor } from "../../chart/drawings/DrawingLayer";
import type { DrawingTemplate } from "../../chart/drawings/prefs";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";

export const BUILTIN_TEMPLATES: readonly DrawingTemplate[] = [
  { id: "builtin-trend", name: "핵심 추세 (기본 2px 우연장)", color: "$draw", width: 2, dash: "solid", extend: "right", opacity: 1 },
  { id: "builtin-support", name: "지지선 (강조 2px 실선)", color: "$accent", width: 2, dash: "solid", extend: "both", opacity: 1 },
  { id: "builtin-resist", name: "저항선 (상승색 2px 파선)", color: "$up", width: 2, dash: "dashed", extend: "both", opacity: 1 },
  { id: "builtin-zone", name: "보조 구역 (하락색 1px 점선)", color: "$down", width: 1, dash: "dotted", extend: "none", opacity: 0.85 },
];

export function applyTemplateStyle(d: DrawingBody, tpl: DrawingTemplate): unknown {
  const bar = toolOf(d.tool)?.bar;
  if (!bar) return d.style;
  let style = d.style;
  if (bar.lineColor) style = bar.lineColor.set(style, tpl.color);
  if (bar.lineOpacity && tpl.opacity !== undefined) style = bar.lineOpacity.set(style, tpl.opacity);
  if (bar.width) style = bar.width.set(style, tpl.width);
  if (bar.dash) style = bar.dash.set(style, tpl.dash);
  if (bar.extend && tpl.extend) style = bar.extend.set(style, tpl.extend);
  if (bar.fill && tpl.fillColor) {
    style = bar.fill.set(style, {
      ...bar.fill.get(style),
      color: tpl.fillColor,
      ...(tpl.fillOn === undefined ? {} : { on: tpl.fillOn }),
      ...(tpl.fillOpacity === undefined ? {} : { opacity: tpl.fillOpacity }),
    });
  }
  return style;
}

export function buildTemplateFromDrawing(d: DrawingBody, name: string): DrawingTemplate | null {
  const bar = toolOf(d.tool)?.bar;
  if (!bar) return null;
  const fill = bar.fill?.get(d.style);
  return {
    id: `tpl-${Date.now()}`,
    name,
    color: bar.lineColor ? drawingColor(bar.lineColor.get(d.style)) : drawingColor("$draw"),
    width: bar.width ? bar.width.get(d.style) : 2,
    dash: bar.dash ? bar.dash.get(d.style) : "solid",
    ...(bar.lineOpacity ? { opacity: bar.lineOpacity.get(d.style) } : {}),
    ...(bar.extend ? { extend: bar.extend.get(d.style) } : {}),
    ...(fill ? { fillOn: fill.on, fillColor: drawingColor(fill.color), fillOpacity: fill.opacity } : {}),
  };
}
