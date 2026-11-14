import { windowId, type WindowId } from "./kinds";

export type Rect = { x: number; y: number; w: number; h: number };

export type DockNode =
  | { kind: "split"; dir: "row" | "column"; ratio: number; first: DockNode; second: DockNode }
  | { kind: "group"; id: string; tabs: WindowId[]; active: WindowId };

export type DockPlacement = { root: DockNode; floats: { window: WindowId; rect: Rect }[] };
export type CanvasPlacement = { rects: Record<WindowId, Rect>; order: WindowId[] };
export type Placement = { v: 1; dock: DockPlacement | null; canvas: CanvasPlacement | null };

export const MAX_DOCK_DEPTH = 32;

type Fields = Record<string, unknown>;

const isFields = (x: unknown): x is Fields => typeof x === "object" && x !== null && !Array.isArray(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isString = (x: unknown): x is string => typeof x === "string";

function readRect(raw: unknown): Rect | null {
  if (!isFields(raw)) return null;
  const { x, y, w, h } = raw;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h) ? { x, y, w, h } : null;
}

function readWindowIds(raw: unknown): WindowId[] | null {
  return Array.isArray(raw) && raw.every(isString) ? raw.map(windowId) : null;
}

function readDockNode(raw: unknown, depth: number, groupIds: Set<string>): DockNode | null {
  if (!isFields(raw)) return null;
  if (raw.kind === "group") {
    const { id, active } = raw;
    const tabs = readWindowIds(raw.tabs);
    if (!isString(id) || groupIds.has(id) || !tabs || tabs.length === 0 || !isString(active) || !tabs.includes(windowId(active))) return null;
    groupIds.add(id);
    return { kind: "group", id, tabs, active: windowId(active) };
  }
  if (raw.kind !== "split" || depth >= MAX_DOCK_DEPTH) return null;
  const { dir, ratio } = raw;
  if ((dir !== "row" && dir !== "column") || !isFiniteNumber(ratio) || ratio <= 0 || ratio >= 1) return null;
  const first = readDockNode(raw.first, depth + 1, groupIds);
  const second = first && readDockNode(raw.second, depth + 1, groupIds);
  return first && second ? { kind: "split", dir, ratio, first, second } : null;
}

function readDock(raw: unknown): DockPlacement | null {
  if (!isFields(raw) || !Array.isArray(raw.floats)) return null;
  const root = readDockNode(raw.root, 0, new Set());
  if (!root) return null;
  const floats: DockPlacement["floats"] = [];
  for (const float of raw.floats) {
    if (!isFields(float) || !isString(float.window)) return null;
    const rect = readRect(float.rect);
    if (!rect) return null;
    floats.push({ window: windowId(float.window), rect });
  }
  return { root, floats };
}

function readCanvas(raw: unknown): CanvasPlacement | null {
  if (!isFields(raw) || !isFields(raw.rects)) return null;
  const order = readWindowIds(raw.order);
  if (!order) return null;
  const rects: [WindowId, Rect][] = [];
  for (const [id, value] of Object.entries(raw.rects)) {
    const rect = readRect(value);
    if (!rect) return null;
    rects.push([windowId(id), rect]);
  }
  return { rects: Object.fromEntries(rects) as Record<WindowId, Rect>, order };
}

export function parsePlacement(raw: unknown): Placement {
  if (isFields(raw) && Object.keys(raw).length === 0) return { v: 1, dock: null, canvas: null };
  if (!isFields(raw) || raw.v !== 1) {
    console.warn("배치가 v 1 객체가 아니어서 빈 배치로 엽니다", raw);
    return { v: 1, dock: null, canvas: null };
  }
  const bad: string[] = [];
  const pick = <T>(key: string, value: unknown, read: (x: unknown) => T | null): T | null => {
    if (value === null || value === undefined) return null;
    const parsed = read(value);
    if (!parsed) bad.push(key);
    return parsed;
  };
  const placement: Placement = { v: 1, dock: pick("dock", raw.dock, readDock), canvas: pick("canvas", raw.canvas, readCanvas) };
  if (bad.length) console.warn(`배치의 ${bad.join(", ")} 모양이 틀려 버립니다`, raw);
  return placement;
}
