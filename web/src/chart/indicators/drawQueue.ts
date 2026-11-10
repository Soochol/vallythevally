import type { LineDraw, Point } from "./protocol";

export type Pending = "redraw" | Point[];

export class DrawQueue<K> {
  private readonly pending = new Map<K, Pending>();

  push(key: K, draw: LineDraw): void {
    if (draw.op === "none") return;
    const p = this.pending.get(key);
    if (draw.op === "set" || p === "redraw") {
      this.pending.set(key, "redraw");
      return;
    }
    const updates = p ?? [];
    const last = updates[updates.length - 1];
    if (last?.t === draw.point.t) updates[updates.length - 1] = draw.point;
    else updates.push(draw.point);
    this.pending.set(key, updates);
  }

  forget(key: K): void {
    this.pending.delete(key);
  }

  get size(): number {
    return this.pending.size;
  }

  drain(): [K, Pending][] {
    const out = [...this.pending];
    this.pending.clear();
    return out;
  }
}

export function applyToPoints(points: Point[], draw: LineDraw): Point[] {
  if (draw.op === "none") return points;
  if (draw.op === "set") return draw.points;
  const last = points[points.length - 1];
  if (last && draw.point.t < last.t) return points;
  if (last?.t === draw.point.t) points[points.length - 1] = draw.point;
  else points.push(draw.point);
  return points;
}

/** t에 놓인 점(정확히 같은 시각). points는 t 오름차순이다. */
export function pointAtTime(points: readonly Point[], t: number): Point | undefined {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = points[mid]!;
    if (p.t === t) return p;
    if (p.t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}
