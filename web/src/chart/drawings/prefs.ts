import { readBool, readOneOf, readRecord } from "./styleKit";
import type { MagnetStrength } from "./magnet";
import { isDrawingTool, type DrawingTool } from "./types";
import { toolOf } from "./tools";

export interface DockAt { x: number; y: number }

export interface DrawingPrefs {
  magnet: boolean;
  magnetStrength: MagnetStrength;
  snapToIndicators: boolean;
  keepDrawing: boolean;
  lockAll: boolean;
  hideAll: boolean;
  lastStyle: Partial<Record<DrawingTool, unknown>>;
  pinnedTools: DrawingTool[];
  newScope: "symbol" | "layout" | "cell";
  dockAt: DockAt | null;
}

export const DEFAULT_DRAWING_PREFS: DrawingPrefs = {
  magnet: true, magnetStrength: "weak", snapToIndicators: false, keepDrawing: false,
  lockAll: false, hideAll: false, lastStyle: {}, pinnedTools: [], newScope: "symbol", dockAt: null,
};

const isRatio = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;

function readDockAt(raw: unknown): DockAt | null {
  const o = readRecord(raw);
  return isRatio(o.x) && isRatio(o.y) ? { x: o.x, y: o.y } : null;
}

export function parseDrawingPrefs(raw: unknown): DrawingPrefs {
  const o = readRecord(raw); const d = DEFAULT_DRAWING_PREFS;
  return { ...o, magnet: readBool(o.magnet, d.magnet), magnetStrength: readOneOf(o.magnetStrength, ["weak", "strong"], d.magnetStrength),
    snapToIndicators: readBool(o.snapToIndicators, false), keepDrawing: readBool(o.keepDrawing, false),
    lockAll: readBool(o.lockAll, false), hideAll: readBool(o.hideAll, false), lastStyle: readRecord(o.lastStyle),
    pinnedTools: Array.isArray(o.pinnedTools) ? [...new Set(o.pinnedTools.filter((value): value is DrawingTool => typeof value === "string" && isDrawingTool(value) && toolOf(value) !== undefined))] : [],
    newScope: readOneOf(o.newScope, ["symbol", "layout", "cell"], "symbol"), dockAt: readDockAt(o.dockAt) };
}
