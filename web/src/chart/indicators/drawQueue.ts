import type { LineDraw, Point } from "./protocol";

export interface Pending {
  set: Point[] | null;
  updates: Point[];
}

/**
 * 다음 프레임에 그릴 지표 점. 시리즈마다 `set` 하나와 그 뒤의 `update`를 점 시각마다 하나씩 둔다.
 * 시리즈당 마지막 값만 남기면 한 프레임에 온 확정 봉의 최종 값과 다음 봉의 첫 값 중 하나를 잃는다.
 */
export class DrawQueue<K> {
  private readonly pending = new Map<K, Pending>();

  push(key: K, draw: LineDraw): void {
    if (draw.op === "none") return;
    if (draw.op === "set") {
      this.pending.set(key, { set: draw.points, updates: [] });
      return;
    }
    const p = this.pending.get(key) ?? { set: null, updates: [] };
    const last = p.updates[p.updates.length - 1];
    if (last?.t === draw.point.t) p.updates[p.updates.length - 1] = draw.point;
    else p.updates.push(draw.point);
    this.pending.set(key, p);
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

/** 점 사본에 그리기를 반영한다. 차트에 그릴 것과 같은 규칙: 마지막 점과 같은 t는 바꾸고, 늦은 t는 덧붙인다. */
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
