import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { PriceAxis } from "./anchor";
import type { Shape } from "./toolSpec";
import { approxTextMeasure, textBounds, textLayout, textLocalPoint, type TextMeasure } from "./textLayout";
import type { DrawingId, DrawingPoint, Extend, ScreenPoint } from "./types";
export { approxTextMeasure, type TextMeasure } from "./textLayout";

export const LINE_HIT_PX = 6;
export const HANDLE_HIT_PX = 6;
export const HANDLE_DIAMETER_PX = 8;
export const AXIS_DECIDE_PX = 8;
const ELLIPSE_ITERATIONS = 6;

export interface Pane {
  width: number;
  height: number;
}

export interface HitItem {
  id: DrawingId;
  z: number;
  shapes: readonly Shape[];
  handles: readonly ScreenPoint[];
}

export type Hit =
  | { kind: "handle"; id: DrawingId; index: number }
  | { kind: "body"; id: DrawingId; part: "line" | "fill" }
  | { kind: "empty" };

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const dist = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function extendedRange(a: ScreenPoint, b: ScreenPoint, extend: Extend): { lo: number; hi: number } {
  const aIsLeft = a.x <= b.x;
  const left = extend === "left" || extend === "both";
  const right = extend === "right" || extend === "both";
  const beforeA = aIsLeft ? left : right;
  const afterB = aIsLeft ? right : left;
  return { lo: beforeA ? -Infinity : 0, hi: afterB ? Infinity : 1 };
}

function farthestCorner(p: ScreenPoint, pane: Pane): number {
  return Math.max(Math.hypot(p.x, p.y), Math.hypot(pane.width - p.x, p.y), Math.hypot(p.x, pane.height - p.y), Math.hypot(pane.width - p.x, pane.height - p.y));
}

export function extendedSegment(a: ScreenPoint, b: ScreenPoint, extend: Extend, pane: Pane): { a: ScreenPoint; b: ScreenPoint } {
  const d = { x: b.x - a.x, y: b.y - a.y };
  if (extend === "none" || d.x * d.x + d.y * d.y === 0) return { a, b };
  const length = Math.hypot(d.x, d.y);
  const u = { x: d.x / length, y: d.y / length };
  const { lo, hi } = extendedRange(a, b, extend);
  const reachA = farthestCorner(a, pane);
  const reachB = farthestCorner(b, pane);
  return {
    a: lo < 0 ? { x: a.x - u.x * reachA, y: a.y - u.y * reachA } : a,
    b: hi > 1 ? { x: b.x + u.x * reachB, y: b.y + u.y * reachB } : b,
  };
}

export function distanceToSegment(a: ScreenPoint, b: ScreenPoint, p: ScreenPoint, extend: Extend = "none"): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(a, p);
  const { lo, hi } = extendedRange(a, b, extend);
  const t = Math.min(hi, Math.max(lo, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist({ x: a.x + t * dx, y: a.y + t * dy }, p);
}

function insidePolygon(points: readonly ScreenPoint[], p: ScreenPoint): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a === undefined || b === undefined) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polylineDistance(points: readonly ScreenPoint[], closed: boolean, p: ScreenPoint): number {
  let best = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[i + 1] ?? (closed ? points[0] : undefined);
    if (a === undefined) continue;
    best = Math.min(best, b === undefined ? dist(a, p) : distanceToSegment(a, b, p));
  }
  return best;
}

function rectEdges(a: ScreenPoint, b: ScreenPoint, extend: Extend, pane: Pane): Box {
  const box = normalize(a, b);
  const left = extend === "left" || extend === "both";
  const right = extend === "right" || extend === "both";
  return { ...box, x1: left ? Math.min(0, box.x1) : box.x1, x2: right ? Math.max(pane.width, box.x2) : box.x2 };
}

export function normalize(a: ScreenPoint, b: ScreenPoint): Box {
  return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
}

const inBox = (box: Box, p: ScreenPoint) => p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2;

function boxEdgeDistance(box: Box, p: ScreenPoint): number {
  const corners = [
    { x: box.x1, y: box.y1 },
    { x: box.x2, y: box.y1 },
    { x: box.x2, y: box.y2 },
    { x: box.x1, y: box.y2 },
  ];
  return polylineDistance(corners, true, p);
}

function ellipseDistance(c: ScreenPoint, rx: number, ry: number, p: ScreenPoint): number {
  if (rx === 0 || ry === 0) return distanceToSegment({ x: c.x - rx, y: c.y - ry }, { x: c.x + rx, y: c.y + ry }, p);
  const px = Math.abs(p.x - c.x);
  const py = Math.abs(p.y - c.y);
  let tx = Math.SQRT1_2;
  let ty = Math.SQRT1_2;
  for (let i = 0; i < ELLIPSE_ITERATIONS; i++) {
    const ex = ((rx * rx - ry * ry) * tx ** 3) / rx;
    const ey = ((ry * ry - rx * rx) * ty ** 3) / ry;
    const r = Math.hypot(rx * tx - ex, ry * ty - ey);
    const q = Math.hypot(px - ex, py - ey);
    if (q === 0) break;
    tx = Math.min(1, Math.max(0, (((px - ex) * r) / q + ex) / rx));
    ty = Math.min(1, Math.max(0, (((py - ey) * r) / q + ey) / ry));
    const t = Math.hypot(tx, ty);
    tx /= t;
    ty /= t;
  }
  return Math.hypot(px - rx * tx, py - ry * ty);
}

export type ShapeHit = "line" | "fill" | null;

export function hitShape(s: Shape, p: ScreenPoint, pane: Pane, measure: TextMeasure = approxTextMeasure): ShapeHit {
  switch (s.kind) {
    case "segment":
      return distanceToSegment(s.a, s.b, p, s.extend) <= LINE_HIT_PX ? "line" : null;
    case "polyline":
      if (s.stroke !== undefined && polylineDistance(s.points, s.closed, p) <= LINE_HIT_PX) return "line";
      return s.fill?.on === true && insidePolygon(s.points, p) ? "fill" : null;
    case "rect": {
      const box = rectEdges(s.a, s.b, s.extend ?? "none", pane);
      if (s.stroke !== undefined && boxEdgeDistance(box, p) <= LINE_HIT_PX) return "line";
      return s.fill?.on === true && inBox(box, p) ? "fill" : null;
    }
    case "ellipse": {
      const c = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
      const rx = Math.abs(s.b.x - s.a.x) / 2;
      const ry = Math.abs(s.b.y - s.a.y) / 2;
      if (s.stroke !== undefined && ellipseDistance(c, rx, ry, p) <= LINE_HIT_PX) return "line";
      const inside = rx > 0 && ry > 0 && ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2 <= 1;
      return s.fill?.on === true && inside ? "fill" : null;
    }
    case "circle": {
      const d = dist(s.c, p);
      if (s.stroke !== undefined && Math.abs(d - s.r) <= LINE_HIT_PX) return "line";
      return s.fill?.on === true && d <= s.r ? "fill" : null;
    }
    case "text":
      return inBox(textLayout(s, measure).bounds, textLocalPoint(s, p)) ? "fill" : null;
    case "hband":
      return s.fill.on && inBox(normalize({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }), p) ? "fill" : null;
    case "vline":
      return Math.abs(p.x - s.x) <= LINE_HIT_PX ? "line" : null;
  }
}

const RANK = { handle: 2, line: 1, fill: 0 } as const;

function nearestHandle(handles: readonly ScreenPoint[], p: ScreenPoint): number {
  let best = -1;
  let bestDistance = Infinity;
  handles.forEach((h, i) => {
    const d = dist(h, p);
    if (d <= HANDLE_HIT_PX && d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

function itemHit(item: HitItem, p: ScreenPoint, pane: Pane, measure: TextMeasure): { hit: Hit; rank: number } | null {
  const handle = nearestHandle(item.handles, p);
  if (handle >= 0) return { hit: { kind: "handle", id: item.id, index: handle }, rank: RANK.handle };
  let part: ShapeHit = null;
  for (const s of item.shapes) {
    const h = hitShape(s, p, pane, measure);
    if (h === "line") return { hit: { kind: "body", id: item.id, part: h }, rank: RANK.line };
    part ??= h;
  }
  return part === null ? null : { hit: { kind: "body", id: item.id, part }, rank: RANK[part] };
}

export function hitTest(items: readonly HitItem[], p: ScreenPoint, pane: Pane, measure: TextMeasure = approxTextMeasure): Hit {
  let best: { hit: Hit; rank: number; z: number } | null = null;
  for (const item of items) {
    const h = itemHit(item, p, pane, measure);
    if (h !== null && (best === null || h.rank > best.rank || (h.rank === best.rank && item.z >= best.z))) best = { ...h, z: item.z };
  }
  return best === null ? { kind: "empty" } : best.hit;
}

export function shapeBounds(s: Shape, pane: Pane, measure: TextMeasure = approxTextMeasure): Box {
  switch (s.kind) {
    case "segment": {
      const { a, b } = extendedSegment(s.a, s.b, s.extend ?? "none", pane);
      return normalize(a, b);
    }
    case "polyline": {
      const xs = s.points.map((q) => q.x);
      const ys = s.points.map((q) => q.y);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    case "rect":
      return rectEdges(s.a, s.b, s.extend ?? "none", pane);
    case "ellipse":
      return normalize(s.a, s.b);
    case "circle":
      return { x1: s.c.x - s.r, y1: s.c.y - s.r, x2: s.c.x + s.r, y2: s.c.y + s.r };
    case "text":
      return textBounds(s, textLayout(s, measure));
    case "hband":
      return normalize({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
    case "vline":
      return { x1: s.x, y1: 0, x2: s.x, y2: pane.height };
  }
}

const intersects = (a: Box, b: Box) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;

export function idsInBox(items: readonly HitItem[], a: ScreenPoint, b: ScreenPoint, pane: Pane, measure: TextMeasure = approxTextMeasure): DrawingId[] {
  const box = normalize(a, b);
  return items.filter((item) => item.shapes.some((s) => intersects(shapeBounds(s, pane, measure), box))).map((item) => item.id);
}

export function constrainAngle45(pivot: ScreenPoint, p: ScreenPoint): ScreenPoint {
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = dx * ux + dy * uy;
  return { x: pivot.x + along * ux, y: pivot.y + along * uy };
}

export function constrainSquare(pivot: ScreenPoint, p: ScreenPoint): ScreenPoint {
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: pivot.x + (dx < 0 ? -side : side), y: pivot.y + (dy < 0 ? -side : side) };
}

export type AxisLock = "undecided" | "horizontal" | "vertical";

export function constrainAxis(lock: AxisLock, delta: ScreenPoint): { lock: AxisLock; delta: ScreenPoint } {
  let decided = lock;
  if (decided === "undecided") {
    if (Math.hypot(delta.x, delta.y) < AXIS_DECIDE_PX) return { lock, delta: { x: 0, y: 0 } };
    decided = Math.abs(delta.x) >= Math.abs(delta.y) ? "horizontal" : "vertical";
  }
  return { lock: decided, delta: decided === "horizontal" ? { x: delta.x, y: 0 } : { x: 0, y: delta.y } };
}

export type NudgeKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface NudgeContext {
  shiftBars(t: UnixSeconds, n: number): UnixSeconds | null;
  price: PriceAxis;
}

export function nudge(points: readonly DrawingPoint[], key: NudgeKey, ctx: NudgeContext): DrawingPoint[] | null {
  const moved: DrawingPoint[] = [];
  for (const p of points) {
    const next = nudgePoint(p, key, ctx);
    if (next === null) return null;
    moved.push(next);
  }
  return moved;
}

function nudgePoint(p: DrawingPoint, key: NudgeKey, ctx: NudgeContext): DrawingPoint | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const t = ctx.shiftBars(p.t, key === "ArrowLeft" ? -1 : 1);
      return t === null ? null : { ...p, t };
    }
    case "ArrowUp":
    case "ArrowDown": {
      const y = ctx.price.toY(p.price);
      const price = y === null ? null : ctx.price.toPrice(key === "ArrowUp" ? y - 1 : y + 1);
      return price === null ? null : { ...p, price };
    }
  }
}
