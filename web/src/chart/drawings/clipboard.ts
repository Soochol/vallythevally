import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { DrawingBody, DrawingId, DrawingPoint, DrawingScope } from "./types";

export const PASTE_SHIFT_BARS = 5;

export interface Clip {
  readonly from: SymbolCode;
  readonly items: readonly [DrawingBody, ...DrawingBody[]];
  readonly pastes: number;
}

export function copy(selected: readonly DrawingBody[], symbol: SymbolCode): Clip | null {
  const [first, ...rest] = [...selected].sort((a, b) => a.z - b.z);
  return first === undefined ? null : { from: symbol, items: [first, ...rest], pastes: 0 };
}

export interface PasteTarget {
  symbol: SymbolCode;
  topZ: number;
  scope: DrawingScope;
  newId(): DrawingId;
  shiftBars(t: UnixSeconds, n: number): UnixSeconds | null;
}

function shifted(points: readonly DrawingPoint[], bars: number, target: PasteTarget): DrawingPoint[] {
  const moved: DrawingPoint[] = [];
  for (const p of points) {
    const t = target.shiftBars(p.t, bars);
    if (t === null) return [...points];
    moved.push({ ...p, t });
  }
  return moved;
}

export function paste(clip: Clip, target: PasteTarget): { bodies: DrawingBody[]; clip: Clip } {
  const sameSymbol = target.symbol === clip.from;
  const bars = sameSymbol ? PASTE_SHIFT_BARS * (clip.pastes + 1) : 0;
  const bodies = clip.items.map((item, i) => ({
    ...item,
    id: target.newId(),
    symbol: target.symbol,
    points: bars === 0 ? [...item.points] : shifted(item.points, bars, target),
    locked: false,
    group: null,
    z: target.topZ + i + 1,
    scope: target.scope,
    revision: 0,
  }));
  return { bodies, clip: sameSymbol ? { ...clip, pastes: clip.pastes + 1 } : clip };
}
