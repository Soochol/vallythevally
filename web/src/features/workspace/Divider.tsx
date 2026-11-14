import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { heldMinSize, moveDivider, ratioForLead, type DividerResult, type DockSpace, type GutterBox } from "../../layout/dock/geometry";
import { listGroups, type Branch, type SplitPath } from "../../layout/dock/tree";
import type { DockNode, DockPlacement } from "../../layout/placement";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export const DIVIDER_KEY_STEP = 16;

const KEY_STEP: Record<"row" | "column", Partial<Record<string, -1 | 1>>> = { row: { ArrowLeft: -1, ArrowRight: 1 }, column: { ArrowUp: -1, ArrowDown: 1 } };

type Drag = { pointer: number; from: number; lead: number; next: number | null; clamped: boolean; sides: string };

function sidesAt(root: DockNode, path: SplitPath): string {
  let node = root;
  for (const branch of path) {
    if (node.kind !== "split") return "";
    node = node[branch];
  }
  if (node.kind !== "split") return "";
  const ids = (side: DockNode) => listGroups(side).map((group) => group.id).join(",");
  return `${node.dir}:${ids(node.first)}|${ids(node.second)}`;
}

function stopNotice(box: GutterBox, space: DockSpace, shrinking: Branch): string {
  const row = box.node.dir === "row";
  const least = heldMinSize(box.node[shrinking], space);
  const side = row ? (shrinking === "first" ? "왼쪽" : "오른쪽") : shrinking === "first" ? "위쪽" : "아래쪽";
  return row ? `${side} 창은 폭 ${least.w}px보다 좁아지지 않습니다` : `${side} 창은 높이 ${least.h}px보다 낮아지지 않습니다`;
}

export function Divider({ box, dock, space, onDraft }: { box: GutterBox; dock: DockPlacement; space: DockSpace; onDraft(dock: DockPlacement | null): void }) {
  const drag = useRef<Drag | null>(null);
  const latest = useRef(dock);
  latest.current = dock;
  const [dragging, setDragging] = useState(false);
  const row = box.node.dir === "row";
  const along = row ? box.bounds.w : box.bounds.h;
  const lead = row ? box.rect.x - box.bounds.x : box.rect.y - box.bounds.y;
  const firstLeast = heldMinSize(box.node.first, space);
  const secondLeast = heldMinSize(box.node.second, space);
  const leastLead = row ? firstLeast.w : firstLeast.h;
  const mostLead = along - space.gap - (row ? secondLeast.w : secondLeast.h);
  const cursor = row ? "dock-resizing-col" : "dock-resizing-row";
  const moveTo = (next: number): DividerResult => moveDivider(latest.current, box.path, ratioForLead(next, along, space.gap), space);
  const notify = (result: DividerResult, next: number) => {
    if (!result.clamped) return;
    const shrinking = leastLead > mostLead ? (next < lead ? "first" : "second") : next < leastLead ? "first" : next > mostLead ? "second" : next < lead ? "first" : "second";
    useSelectionStore.getState().showToast(stopNotice(box, space, shrinking));
  };

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, from: row ? event.clientX : event.clientY, lead, next: null, clamped: false, sides: sidesAt(latest.current.root, box.path) };
    document.documentElement.classList.add(cursor);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    if (sidesAt(latest.current.root, box.path) !== current.sides) return finish(false);
    const next = current.lead + (row ? event.clientX : event.clientY) - current.from;
    const result = moveTo(next);
    if (!current.clamped) notify(result, next);
    current.clamped = result.clamped;
    current.next = next;
    onDraft(result.dock);
  };
  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.documentElement.classList.remove(cursor);
    setDragging(false);
    if (commit && current.next !== null && sidesAt(latest.current.root, box.path) === current.sides) useLayoutStore.getState().setDock(moveTo(current.next).dock);
    onDraft(null);
  };
  const press = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = KEY_STEP[box.node.dir][event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const next = lead + direction * DIVIDER_KEY_STEP;
    const result = moveTo(next);
    notify(result, next);
    useLayoutStore.getState().setDock(result.dock);
  };

  return (
    <div data-chart-control role="separator" tabIndex={0} className="dock-divider"
      aria-orientation={row ? "vertical" : "horizontal"} aria-label={row ? "좌우 창 경계" : "위아래 창 경계"}
      aria-valuenow={lead} aria-valuemin={leastLead} aria-valuemax={mostLead}
      title="끌어서 창 크기 조절" data-dragging={dragging ? "" : undefined}
      style={{ left: box.rect.x, top: box.rect.y, width: box.rect.w, height: box.rect.h }}
      onPointerDown={start} onPointerMove={move} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(true)}
      onKeyDown={press} />
  );
}
