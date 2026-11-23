import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { leadRange, type LeadRange } from "../../layout/dock/axis";
import { equalizeRun } from "../../layout/dock/balance";
import { dockMinSize, layoutDock, ratioForLead, wholePixels, type DockLayout, type DockSpace, type GutterBox } from "../../layout/dock/geometry";
import { pushDivider } from "../../layout/dock/push";
import { dividerStops, nextStop, snapLead, type Stop } from "../../layout/dock/stops";
import { listGroups, type Branch, type SplitPath } from "../../layout/dock/tree";
import type { DockNode, DockPlacement, Rect } from "../../layout/placement";
import { useSelectionStore } from "../../stores/selection";
import { DIVIDER_REACH, reachesDivider, yieldsToContent } from "./dividerReach";
import { DividerMenu } from "./DividerMenu";
import { DockSizeBalloon, sharePercent, sideName, speakSize, type Point, type SideSize } from "./DockSizeBalloon";

export const DIVIDER_KEY_STEP = 16;
const FINE_KEY_STEP = 1;
const KEYBOARD_BALLOON_MS = 1000;
const GUIDE_THICKNESS = 2;

const KEY_STEP: Record<"row" | "column", Partial<Record<string, -1 | 1>>> = { row: { ArrowLeft: -1, ArrowRight: 1 }, column: { ArrowUp: -1, ArrowDown: 1 } };

type Drag = { pointer: number; from: number; lead: number; raw: number | null; at: Point; alt: boolean; clamped: boolean; sides: string; stops: Stop[]; layout: DockLayout };
type Hud = { point: Point | null; guide: Rect | null };
type Live = { dock: DockPlacement; box: GutterBox; space: DockSpace; onDraft(dock: DockPlacement | null): void; onCommit: CommitRatios };
export type CommitRatios = (next: DockPlacement, from: DockPlacement) => void;

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

function measure(box: GutterBox, space: DockSpace) {
  const px = wholePixels(space);
  const row = box.node.dir === "row";
  const along = row ? box.bounds.w : box.bounds.h;
  const lead = row ? box.rect.x - box.bounds.x : box.rect.y - box.bounds.y;
  const gutter = row ? box.rect.w : box.rect.h;
  return { px, row, along, lead, second: along - lead - gutter, range: leadRange(box, px) };
}

function stopNotice(box: GutterBox, space: DockSpace, shrinking: Branch): string {
  const row = box.node.dir === "row";
  const least = dockMinSize(box.node[shrinking], space);
  const side = row ? (shrinking === "first" ? "왼쪽" : "오른쪽") : shrinking === "first" ? "위쪽" : "아래쪽";
  return row ? `${side} 창은 폭 ${least.w}px보다 좁아지지 않습니다` : `${side} 창은 높이 ${least.h}px보다 낮아지지 않습니다`;
}

function settle(live: Live, raw: number, alt: boolean, stops: readonly Stop[]) {
  const { box, space, dock } = live;
  const m = measure(box, space);
  const snapped = alt ? { lead: raw, stop: null } : snapLead(raw, stops);
  const result = pushDivider(dock, box.path, ratioForLead(snapped.lead, m.along, m.px.gap), space);
  const clamped = m.range === null || raw < m.range.min || raw > m.range.max;
  return { dock: result.dock, clamped, stop: snapped.stop, m };
}

function notify(live: Live, raw: number) {
  const { box, space } = live;
  const m = measure(box, space);
  const range: LeadRange | null = m.range;
  const shrinking: Branch = range && raw < range.min ? "first" : range && raw > range.max ? "second" : raw < m.lead ? "first" : "second";
  useSelectionStore.getState().showToast(stopNotice(box, space, shrinking));
}

function guideLine(stop: Stop, box: GutterBox, layout: DockLayout, gap: number): Rect {
  const row = box.node.dir === "row";
  const origin = row ? box.bounds.x : box.bounds.y;
  let start = row ? box.bounds.y : box.bounds.x;
  let end = start + (row ? box.bounds.h : box.bounds.w);
  for (const other of layout.gutters) {
    if (other.node.dir !== box.node.dir || other.path.join() === box.path.join()) continue;
    if ((row ? other.rect.x : other.rect.y) - origin !== stop.lead) continue;
    start = Math.min(start, row ? other.rect.y : other.rect.x);
    end = Math.max(end, row ? other.rect.y + other.rect.h : other.rect.x + other.rect.w);
  }
  const at = stop.guide + gap / 2 - GUIDE_THICKNESS / 2;
  return row ? { x: at, y: start, w: GUIDE_THICKNESS, h: end - start } : { x: start, y: at, w: end - start, h: GUIDE_THICKNESS };
}

const sizes = (box: GutterBox, space: DockSpace): { lead: SideSize; second: SideSize } => {
  const m = measure(box, space);
  return { lead: { name: sideName(box.node.first, space.windows), px: m.lead }, second: { name: sideName(box.node.second, space.windows), px: m.second } };
};

export function Divider({ box, dock, space, onDraft, onCommit }: { box: GutterBox; dock: DockPlacement; space: DockSpace; onDraft(dock: DockPlacement | null): void; onCommit: CommitRatios }) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const balloonTimer = useRef<number | undefined>(undefined);
  const live = useRef<Live>({ dock, box, space, onDraft, onCommit });
  live.current = { dock, box, space, onDraft, onCommit };
  const [dragging, setDragging] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  const [menuAt, setMenuAt] = useState<Point | null>(null);
  const m = measure(box, space);
  const row = m.row;
  const range = m.range ?? { min: m.lead, max: m.lead };
  const shown = sizes(box, space);
  const percent = sharePercent(shown.lead.px, shown.second.px);

  const hostPoint = (clientX: number, clientY: number): Point => {
    const host = element.current?.parentElement?.getBoundingClientRect();
    return { x: clientX - (host?.left ?? 0), y: clientY - (host?.top ?? 0) };
  };
  const step = (current: Drag) => {
    const now = live.current;
    if (sidesAt(now.dock.root, now.box.path) !== current.sides) return finish(false);
    const horizontal = now.box.node.dir === "row";
    const raw = current.lead + (horizontal ? current.at.x : current.at.y) - current.from;
    const result = settle(now, raw, current.alt, current.stops);
    if (!current.clamped && result.clamped) notify(now, raw);
    current.clamped = result.clamped;
    current.raw = raw;
    now.onDraft(result.dock);
    setHud({ point: hostPoint(current.at.x, current.at.y), guide: result.stop ? guideLine(result.stop, now.box, current.layout, result.m.px.gap) : null });
  };
  const begin = (target: HTMLElement, pointer: number, clientX: number, clientY: number) => {
    const now = live.current;
    const px = wholePixels(now.space);
    const start = measure(now.box, now.space);
    target.setPointerCapture(pointer);
    window.clearTimeout(balloonTimer.current);
    drag.current = {
      pointer,
      from: start.row ? clientX : clientY,
      lead: start.lead,
      raw: null,
      at: { x: clientX, y: clientY },
      alt: false,
      clamped: false,
      sides: sidesAt(now.dock.root, now.box.path),
      stops: dividerStops(now.dock, now.box.path, now.space),
      layout: layoutDock(now.dock.root, px.area, px.gap),
    };
    document.documentElement.classList.add(start.row ? "dock-resizing-col" : "dock-resizing-row");
    setDragging(true);
  };
  const end = () => {
    drag.current = null;
    document.documentElement.classList.remove("dock-resizing-col", "dock-resizing-row");
    setDragging(false);
    setHud(null);
  };
  const finish = (commit: boolean, alt?: boolean) => {
    const current = drag.current;
    if (!current) return;
    const now = live.current;
    end();
    if (commit && current.raw !== null && sidesAt(now.dock.root, now.box.path) === current.sides) now.onCommit(settle(now, current.raw, alt ?? current.alt, current.stops).dock, now.dock);
    now.onDraft(null);
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

  useEffect(() => {
    const host = element.current?.parentElement;
    if (!host) return;
    const onDown = (event: PointerEvent) => {
      const target = element.current;
      if (!target || event.button !== 0 || !event.isPrimary || drag.current) return;
      const origin = host.getBoundingClientRect();
      const { box: now } = live.current;
      if (!reachesDivider({ x: event.clientX - origin.left, y: event.clientY - origin.top }, now.rect, now.node.dir === "row", DIVIDER_REACH) || yieldsToContent(event, host)) return;
      event.preventDefault();
      event.stopPropagation();
      begin(target, event.pointerId, event.clientX, event.clientY);
    };
    host.addEventListener("pointerdown", onDown, true);
    return () => host.removeEventListener("pointerdown", onDown, true);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(balloonTimer.current);
    document.documentElement.classList.remove("dock-resizing-col", "dock-resizing-row");
  }, []);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    begin(event.currentTarget, event.pointerId, event.clientX, event.clientY);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    current.alt = event.altKey;
    current.at = { x: event.clientX, y: event.clientY };
    step(current);
  };
  const flashBalloon = () => {
    window.clearTimeout(balloonTimer.current);
    setHud({ point: null, guide: null });
    balloonTimer.current = window.setTimeout(() => setHud(null), KEYBOARD_BALLOON_MS);
  };
  const openMenu = (x: number, y: number) => {
    element.current?.focus({ preventScroll: true });
    setMenuAt({ x, y });
  };
  const openMenuAtCenter = () => {
    const rect = element.current?.getBoundingClientRect();
    if (rect) openMenu(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  const press = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openMenuAtCenter();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const now = live.current;
    const here = measure(now.box, now.space);
    const direction = KEY_STEP[now.box.node.dir][event.key];
    let target: number;
    if (direction !== undefined) target = here.lead + direction * (event.shiftKey ? FINE_KEY_STEP : DIVIDER_KEY_STEP);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const stop = nextStop(here.lead, dividerStops(now.dock, now.box.path, now.space), event.key === "PageUp" ? -1 : 1);
      if (!stop) return;
      target = stop.lead;
    } else if (event.key === "Home" || event.key === "End") target = (here.range ?? { min: here.lead, max: here.lead })[event.key === "Home" ? "min" : "max"];
    else return;
    event.preventDefault();
    const result = settle(now, target, true, []);
    if (result.clamped) notify(now, target);
    now.onCommit(result.dock, now.dock);
    flashBalloon();
  };
  const doubleClick = () => {
    const now = live.current;
    const px = wholePixels(now.space);
    const next = equalizeRun(now.dock, now.box.path, now.space);
    const rects = (placement: DockPlacement) => JSON.stringify(layoutDock(placement.root, px.area, px.gap).groups.map(({ rect }) => rect));
    if (rects(next) !== rects(now.dock)) now.onCommit(next, now.dock);
  };

  const balloonPoint = hud && (hud.point ?? { x: box.rect.x + box.rect.w / 2, y: box.rect.y + box.rect.h / 2 });
  return (
    <>
      <div ref={element} data-chart-control role="separator" tabIndex={0} className="dock-divider"
        aria-orientation={row ? "vertical" : "horizontal"} aria-label={row ? "좌우 창 경계" : "위아래 창 경계"}
        aria-valuenow={m.lead} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuetext={speakSize(shown.lead, percent)}
        title="끌어서 창 크기 조절. 두 번 누르면 같은 방향 창을 고르게" data-dragging={dragging ? "" : undefined}
        style={{ left: box.rect.x, top: box.rect.y, width: box.rect.w, height: box.rect.h }}
        onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(true, event.altKey)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(true)}
        onKeyDown={press} onDoubleClick={doubleClick}
        onContextMenu={(event) => {
          event.preventDefault();
          if (event.clientX === 0 && event.clientY === 0) openMenuAtCenter();
          else openMenu(event.clientX, event.clientY);
        }} />
      {menuAt && <DividerMenu box={box} dock={dock} space={space} onCommit={onCommit} root={element} at={menuAt} onClose={() => {
        setMenuAt(null);
        element.current?.focus({ preventScroll: true });
      }} />}
      {hud?.guide && <div data-dock-snap-guide className="dock-snap-guide" style={{ left: hud.guide.x, top: hud.guide.y, width: hud.guide.w, height: hud.guide.h }} />}
      {hud && balloonPoint && <DockSizeBalloon lead={shown.lead} second={shown.second} area={m.px.area} point={balloonPoint} />}
    </>
  );
}
