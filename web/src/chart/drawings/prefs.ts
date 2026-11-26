import { readBool, readNumber, readOneOf, readRecord, readString } from "./styleKit";
import type { MagnetStrength } from "./magnet";
import { isDrawingTool, type Dash, type DrawingTool, type Extend, type Width } from "./types";
import { toolOf } from "./tools";

export interface DrawingTemplate {
  id: string;
  name: string;
  color: string;
  opacity?: number;
  width: Width;
  dash: Dash;
  extend?: Extend;
  fillOn?: boolean;
  fillColor?: string;
  fillOpacity?: number;
}

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
  toolbarHidden: boolean;
  favoritesBar: boolean;
  favoritesBarAt: { x: number; y: number } | null;
  favoritesBarVertical: boolean;
  styleTemplates: DrawingTemplate[];
}

export const DEFAULT_DRAWING_PREFS: DrawingPrefs = {
  magnet: true, magnetStrength: "weak", snapToIndicators: false, keepDrawing: false,
  lockAll: false, hideAll: false, lastStyle: {}, pinnedTools: [], newScope: "symbol", toolbarHidden: false,
  favoritesBar: true, favoritesBarAt: null, favoritesBarVertical: false, styleTemplates: [],
};

function readPoint(raw: unknown): { x: number; y: number } | null {
  const o = readRecord(raw);
  return typeof o.x === "number" && Number.isFinite(o.x) && typeof o.y === "number" && Number.isFinite(o.y) ? { x: o.x, y: o.y } : null;
}

function readTemplates(raw: unknown): DrawingTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DrawingTemplate[] => {
    const o = readRecord(item);
    const id = readString(o.id, "");
    const name = readString(o.name, "").trim();
    const color = readString(o.color, "");
    if (!id || !name || !color) return [];
    const width = readOneOf(o.width, [1, 2, 3, 4, 5] as const, 2);
    const dash = readOneOf(o.dash, ["solid", "dashed", "dotted"] as const, "solid");
    const extend = typeof o.extend === "string" ? readOneOf(o.extend, ["none", "left", "right", "both"] as const, "none") : undefined;
    const opacity = typeof o.opacity === "number" && Number.isFinite(o.opacity) ? Math.min(1, Math.max(0.1, o.opacity)) : undefined;
    const fillOn = typeof o.fillOn === "boolean" ? o.fillOn : undefined;
    const fillColor = typeof o.fillColor === "string" ? o.fillColor : undefined;
    const fillOpacity = typeof o.fillOpacity === "number" && Number.isFinite(o.fillOpacity) ? Math.min(1, Math.max(0, readNumber(o.fillOpacity, 0.2))) : undefined;
    return [{ id, name, color, width, dash, ...(opacity === undefined ? {} : { opacity }), ...(extend === undefined ? {} : { extend }), ...(fillOn === undefined ? {} : { fillOn }), ...(fillColor === undefined ? {} : { fillColor }), ...(fillOpacity === undefined ? {} : { fillOpacity }) }];
  }).slice(0, 20);
}

export function parseDrawingPrefs(raw: unknown): DrawingPrefs {
  const { dockAt: _retired, ...o } = readRecord(raw); const d = DEFAULT_DRAWING_PREFS;
  return { ...o, magnet: readBool(o.magnet, d.magnet), magnetStrength: readOneOf(o.magnetStrength, ["weak", "strong"], d.magnetStrength),
    snapToIndicators: readBool(o.snapToIndicators, false), keepDrawing: readBool(o.keepDrawing, false),
    lockAll: readBool(o.lockAll, false), hideAll: readBool(o.hideAll, false), lastStyle: readRecord(o.lastStyle),
    pinnedTools: Array.isArray(o.pinnedTools) ? [...new Set(o.pinnedTools.filter((value): value is DrawingTool => typeof value === "string" && isDrawingTool(value) && toolOf(value) !== undefined))] : [],
    newScope: readOneOf(o.newScope, ["symbol", "layout", "cell"], "symbol"), toolbarHidden: readBool(o.toolbarHidden, false),
    favoritesBar: readBool(o.favoritesBar, true), favoritesBarAt: readPoint(o.favoritesBarAt),
    favoritesBarVertical: readBool(o.favoritesBarVertical, false), styleTemplates: readTemplates(o.styleTemplates) };
}
