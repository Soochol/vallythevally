import type { DrawingPoint } from "../../api/generated/DrawingPoint";
import type { WindowId } from "../../layout/kinds";
import * as clipboard from "./clipboard";
import { nudge, type NudgeContext, type NudgeKey } from "./geometry";
import type { Tool } from "./toolSpec";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingOp, DrawingScope } from "./types";

export interface DrawingStore {
  drawings(symbol: string): DrawingBody[];
  commit(cellId: WindowId, ops: readonly DrawingOp[]): boolean;
  commitWithUndo(cellId: WindowId, ops: readonly DrawingOp[], message: string): void;
}

export interface EditTarget {
  readonly symbol: string;
  readonly scope: DrawingScope;
}

export type ReorderDirection = "front" | "forward" | "backward" | "back";

export const REMOVED = "드로잉을 지웠습니다";

const topZ = (drawings: readonly DrawingBody[]) => Math.max(0, ...drawings.map((d) => d.z));

export class DrawingEdits {
  constructor(
    private readonly store: DrawingStore,
    private readonly cellId: WindowId,
    private readonly target: () => EditTarget | null,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  selected(ids: readonly string[]): DrawingBody[] {
    const target = this.target();
    return target ? this.store.drawings(target.symbol).filter((d) => ids.includes(d.id)) : [];
  }

  find(id: string): DrawingBody | undefined {
    const target = this.target();
    return target ? this.store.drawings(target.symbol).find((d) => d.id === id) : undefined;
  }

  place(tool: Tool, points: DrawingPoint[], style: unknown): DrawingBody | null {
    const target = this.target();
    if (!target) return null;
    const body: DrawingBody = { id: this.newId(), symbol: target.symbol, tool: tool.tool, points, style, text: null, locked: false, hidden: false,
      z: topZ(this.store.drawings(target.symbol)) + 1, periods: null, scope: target.scope, group: null, revision: 0 };
    this.store.commit(this.cellId, [{ kind: "create", after: body }]);
    return body;
  }

  clone(drawings: readonly DrawingBody[]): DrawingBody[] {
    const target = this.target();
    if (!target) return [];
    const z = topZ(this.store.drawings(target.symbol));
    const clones = drawings.map((d, i) => ({ ...d, id: this.newId(), locked: false, group: null, scope: target.scope, z: z + i + 1, revision: 0 }));
    this.store.commit(this.cellId, clones.map((after) => ({ kind: "create", after })));
    return clones;
  }

  paste(clip: clipboard.Clip, shiftBars: NudgeContext["shiftBars"]): ReturnType<typeof clipboard.paste> | null {
    const target = this.target();
    if (!target) return null;
    const result = clipboard.paste(clip, { symbol: target.symbol, topZ: topZ(this.store.drawings(target.symbol)), scope: target.scope, newId: this.newId, shiftBars });
    this.store.commit(this.cellId, result.bodies.map((after) => ({ kind: "create", after })));
    return result;
  }

  update(ids: readonly string[], change: (d: DrawingBody) => DrawingBody): { before: DrawingBody; after: DrawingBody }[] {
    const ops = this.selected(ids).map((before) => ({ kind: "update" as const, before, after: change(before) }));
    this.store.commit(this.cellId, ops);
    return ops;
  }

  move(previews: readonly DrawingBody[], originals: readonly DrawingBody[]) {
    const ops: DrawingOp[] = previews.flatMap((after) => { const before = originals.find((d) => d.id === after.id); return before ? [{ kind: "update" as const, before, after }] : []; });
    this.store.commit(this.cellId, ops);
  }

  nudge(ids: readonly string[], key: NudgeKey, axes: NudgeContext, lockAll: boolean) {
    this.store.commit(this.cellId, this.selected(ids).filter((d) => !d.locked && !lockAll).flatMap((before) => {
      const points = nudge(before.points, key, axes, toolOf(before.tool)?.pointRoles);
      return points && points.some((p, i) => p !== before.points[i]) ? [{ kind: "update" as const, before, after: { ...before, points } }] : [];
    }));
  }

  remove(ids: readonly string[], { force, lockAll }: { force: boolean; lockAll: boolean }) {
    this.store.commitWithUndo(this.cellId, this.selected(ids).filter((d) => force || (!d.locked && !lockAll)).map((before) => ({ kind: "delete", before })), REMOVED);
  }

  reorder(id: string, direction: ReorderDirection, targetId?: string, dropPosition: "above" | "below" = "below") {
    const target = this.target(); if (!target) return;
    const all = this.store.drawings(target.symbol); const current = all.find((d) => d.id === id); if (!current) return;
    const rest = all.filter((d) => d.id !== id);
    const index = targetId ? rest.findIndex((d) => d.id === targetId) + (dropPosition === "above" ? 1 : 0) : direction === "front" ? rest.length : direction === "back" ? 0 : Math.max(0, Math.min(rest.length, all.indexOf(current) + (direction === "forward" ? 1 : -1)));
    const lo = rest[index - 1]?.z; const hi = rest[index]?.z;
    const z = lo === undefined ? (hi ?? 1) - 1 : hi === undefined ? lo + 1 : (lo + hi) / 2;
    if (lo !== undefined && hi !== undefined && hi - lo < 1e-9) {
      rest.splice(index, 0, current); this.store.commit(this.cellId, rest.map((d, i) => ({ kind: "update", before: d, after: { ...d, z: i + 1 } })));
    } else this.store.commit(this.cellId, [{ kind: "update", before: current, after: { ...current, z } }]);
  }
}
