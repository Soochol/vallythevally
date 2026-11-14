import { inScope } from "./frame";
import { readRecord } from "./styleKit";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingScope } from "./types";
import type { WindowId } from "../../layout/kinds";

export function objectName(drawing: DrawingBody): string {
  const name = readRecord(drawing.style).objectName;
  return typeof name === "string" && name.trim() ? name : drawing.text?.slice(0, 20) || toolOf(drawing.tool)?.label || drawing.tool;
}

export function renameObject(drawing: DrawingBody, name: string): DrawingBody {
  return { ...drawing, style: { ...readRecord(drawing.style), objectName: name.trim() } };
}

export function reusableStyle(style: unknown): unknown {
  const { objectName: _name, ...rest } = readRecord(style);
  return rest;
}

export function defaultObjectStyle(drawing: DrawingBody): unknown {
  const defaults = readRecord(toolOf(drawing.tool)?.defaultStyle());
  const name = readRecord(drawing.style).objectName;
  return name === undefined ? defaults : { ...defaults, objectName: name };
}

const SCOPE_LABEL: Record<DrawingScope["kind"], string> = { cell: "이 칸", layout: "이 레이아웃 공통", symbol: "이 종목 모든 칸 공통" };
const SCOPE_ORDER = ["cell", "layout", "symbol"] as const;

export function objectGroups(drawings: readonly DrawingBody[], layoutId: string, cellId: WindowId) {
  const visible = drawings.filter((d) => inScope(d.scope, layoutId, cellId)).sort((a, b) => b.z - a.z);
  return SCOPE_ORDER.map((kind) => ({ kind, label: SCOPE_LABEL[kind], drawings: visible.filter((d) => d.scope.kind === kind) })).filter((group) => group.drawings.length > 0);
}
