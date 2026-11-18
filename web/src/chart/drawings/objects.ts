import { readRecord } from "./styleKit";
import { toolOf } from "./tools";
import type { DrawingBody } from "./types";

export function reusableStyle(style: unknown): unknown {
  const { objectName: _name, ...rest } = readRecord(style);
  return rest;
}

export function defaultObjectStyle(drawing: DrawingBody): unknown {
  const defaults = readRecord(toolOf(drawing.tool)?.defaultStyle());
  const name = readRecord(drawing.style).objectName;
  return name === undefined ? defaults : { ...defaults, objectName: name };
}
