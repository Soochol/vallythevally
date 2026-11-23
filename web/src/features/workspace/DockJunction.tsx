import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { wholePixels, type DockLayout, type DockSpace, type GutterBox } from "../../layout/dock/geometry";
import type { Junction } from "../../layout/dock/junction";
import type { DockPlacement, Rect } from "../../layout/placement";
import { useSelectionStore } from "../../stores/selection";
import type { CommitRatios } from "./Divider";
import { DockSizeBalloon, sideName, type Point, type SideSize } from "./DockSizeBalloon";
import { junctionStart, junctionStopNotice, moveJunction, type JunctionAxis, type JunctionMove, type JunctionStart } from "./junctionDrag";

const GUIDE_THICKNESS = 2;
const LINE_INSET = 16;
const BALLOON_STACK_OFFSET = 28;
const AXES: readonly JunctionAxis[] = ["row", "column"];

type Drag = { pointer: number; from: Point; at: Point; alt: boolean; start: JunctionStart; dock: DockPlacement; notified: Record<JunctionAxis, boolean>; result: JunctionMove | null };
type Hud = { point: Point; result: JunctionMove };

const lineOf = (box: GutterBox): Rect =>
  box.node.dir === "row"
    ? { x: box.rect.x + box.rect.w / 2 - GUIDE_THICKNESS / 2, y: box.bounds.y + LINE_INSET, w: GUIDE_THICKNESS, h: box.bounds.h - 2 * LINE_INSET }
    : { x: box.bounds.x + LINE_INSET, y: box.rect.y + box.rect.h / 2 - GUIDE_THICKNESS / 2, w: box.bounds.w - 2 * LINE_INSET, h: GUIDE_THICKNESS };

const guideOf = (box: GutterBox, guide: number, gap: number): Rect =>
  box.node.dir === "row"
    ? { x: box.bounds.x + guide + gap / 2 - GUIDE_THICKNESS / 2, y: box.bounds.y, w: GUIDE_THICKNESS, h: box.bounds.h }
    : { x: box.bounds.x, y: box.bounds.y + guide + gap / 2 - GUIDE_THICKNESS / 2, w: box.bounds.w, h: GUIDE_THICKNESS };

const place = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });

function sidesOf(box: GutterBox, space: DockSpace): { lead: SideSize; second: SideSize } {
  const row = box.node.dir === "row";
  const along = row ? box.bounds.w : box.bounds.h;
  const lead = row ? box.rect.x - box.bounds.x : box.rect.y - box.bounds.y;
  const gutter = row ? box.rect.w : box.rect.h;
  return { lead: { name: sideName(box.node.first, space.windows), px: lead }, second: { name: sideName(box.node.second, space.windows), px: along - lead - gutter } };
}

export function DockJunction({ junction, layout, dock, space, onDraft, onCommit }: { junction: Junction; layout: DockLayout; dock: DockPlacement; space: DockSpace; onDraft(dock: DockPlacement | null): void; onCommit: CommitRatios }) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const live = useRef({ dock, junction, space, onDraft, onCommit });
  live.current = { dock, junction, space, onDraft, onCommit };
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  const lines = layout.gutters.filter((box) => box.path.join() === junction.rowPath.join() || box.path.join() === junction.columnPath.join());

  const step = (current: Drag) => {
    const now = live.current;
    const delta = { x: current.at.x - current.from.x, y: current.at.y - current.from.y };
    const result = moveJunction(current.dock, now.junction, current.start, delta, current.alt, now.space);
    if (!result) return;
    for (const axis of AXES) {
      const shrinking = result.clamped[axis];
      if (shrinking && !current.notified[axis]) useSelectionStore.getState().showToast(junctionStopNotice(result.boxes[axis], now.space, shrinking));
      current.notified[axis] = shrinking !== null;
    }
    current.result = result;
    now.onDraft(result.dock);
    const host = element.current?.parentElement?.getBoundingClientRect();
    setHud({ point: { x: current.at.x - (host?.left ?? 0), y: current.at.y - (host?.top ?? 0) }, result });
  };
  const end = () => {
    drag.current = null;
    document.documentElement.classList.remove("dock-resizing-junction");
    setDragging(false);
    setHud(null);
  };
  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    end();
    if (commit && current.result) live.current.onCommit(current.result.dock, current.dock);
    live.current.onDraft(null);
  };
  const cancel = () => {
    const current = drag.current;
    if (!current) return;
    end();
    live.current.onDraft(null);
    if (element.current?.hasPointerCapture(current.pointer)) element.current.releasePointerCapture(current.pointer);
  };

  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.type === "keydown") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      const current = drag.current;
      if (event.key !== "Alt" || !current) return;
      event.preventDefault();
      current.alt = event.type === "keydown";
      step(current);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKey, true);
    };
  }, [dragging]);

  useEffect(() => () => document.documentElement.classList.remove("dock-resizing-junction"), []);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    const now = live.current;
    const origin = junctionStart(now.dock, now.junction, now.space);
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = { x: event.clientX, y: event.clientY };
    drag.current = { pointer: event.pointerId, from: at, at, alt: event.altKey, start: origin, dock: now.dock, notified: { row: false, column: false }, result: null };
    document.documentElement.classList.add("dock-resizing-junction");
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    current.alt = event.altKey;
    current.at = { x: event.clientX, y: event.clientY };
    step(current);
  };

  const px = wholePixels(space);
  const shown = hud?.result;
  return (
    <>
      {(hovered || dragging) && lines.map((box) => <div key={box.path.join("-") || "root"} className="dock-junction-line" style={place(lineOf(box))} />)}
      <div ref={element} data-chart-control data-dock-junction className="dock-junction" aria-hidden="true" data-dragging={dragging ? "" : undefined}
        style={place(junction.rect)}
        onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onPointerDown={start} onPointerMove={move} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(true)} />
      {shown && AXES.map((axis) => {
        const stop = shown.stops[axis];
        return stop ? <div key={`guide-${axis}`} data-dock-snap-guide className="dock-snap-guide" style={place(guideOf(shown.boxes[axis], stop.guide, px.gap))} /> : null;
      })}
      {hud && shown && AXES.map((axis, index) => {
        const sides = sidesOf(shown.boxes[axis], space);
        return <DockSizeBalloon key={`balloon-${axis}`} lead={sides.lead} second={sides.second} area={px.area} point={{ x: hud.point.x, y: hud.point.y + index * BALLOON_STACK_OFFSET }} />;
      })}
    </>
  );
}
