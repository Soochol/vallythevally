import { readBool, readOneOf, readRecord } from "./styleKit";
import type { MagnetStrength } from "./magnet";
import type { DrawingTool } from "./types";

export interface DrawingPrefs {
  magnet: boolean;
  magnetStrength: MagnetStrength;
  snapToIndicators: boolean;
  keepDrawing: boolean;
  lockAll: boolean;
  hideAll: boolean;
  lastStyle: Partial<Record<DrawingTool, unknown>>;
  newScope: "symbol" | "layout" | "cell";
}

export const DEFAULT_DRAWING_PREFS: DrawingPrefs = {
  magnet: true, magnetStrength: "weak", snapToIndicators: false, keepDrawing: false,
  lockAll: false, hideAll: false, lastStyle: {}, newScope: "symbol",
};

export function parseDrawingPrefs(raw: unknown): DrawingPrefs {
  const o = readRecord(raw); const d = DEFAULT_DRAWING_PREFS;
  return { ...o, magnet: readBool(o.magnet, d.magnet), magnetStrength: readOneOf(o.magnetStrength, ["weak", "strong"], d.magnetStrength),
    snapToIndicators: readBool(o.snapToIndicators, false), keepDrawing: readBool(o.keepDrawing, false),
    lockAll: readBool(o.lockAll, false), hideAll: readBool(o.hideAll, false), lastStyle: readRecord(o.lastStyle),
    newScope: readOneOf(o.newScope, ["symbol", "layout", "cell"], "symbol") };
}
