import { type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { minWindowSize, toPx, toRatio, workArea, type Area } from "../../layout/canvas/geometry";
import { moveRect, resizeRect, type Guides, type ResizeHandle } from "../../layout/canvas/snap";
import { carryMove } from "../../layout/dock/carry";
import { canDetach, detachedRect, detachWindow, floatRects, frontFloat, LAST_DOCKED_NOTICE, moveFloat } from "../../layout/dock/floats";
import type { DockSpace } from "../../layout/dock/geometry";
import { groupOfWindow } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { DockPlacement, Rect } from "../../layout/placement";
import { useLayoutStore, windowName, type WindowState } from "../../stores/layout";
import { touchWindow } from "../../stores/activeWindow";
import { useSelectionStore } from "../../stores/selection";
import { ladderRateHidden, useUiStore } from "../../stores/ui";
import { commandAt, evaluateView, type DockCommand, type DockPlan } from "./dockCommands";
import { closeWindow } from "./manage";
import { focusWithoutActivation, isProgrammaticFocus } from "./focus";
import type { FrameBindings } from "./WindowFrame";
import {
  applyArrowGeometry,
  ARROWS,
  type GestureCursor,
  isInteractiveTarget,
  minimumWindowNotice,
  NO_GUIDES,
  type Point,
  RESIZE_CURSOR,
  topologyOf,
  usePointerGesture,
} from "./windowGesture";

export type TabMenu = { window: WindowId; x: number; y: number };
type Operation = { kind: "tab" } | { kind: "float-move"; rect: Rect } | { kind: "float-resize"; rect: Rect; handle: ResizeHandle };
type ActiveDrag = { window: WindowId; operation: Operation };
type Start = { pointer: number; window: WindowState; operation: Operation; point: Point; area: Area; dock: DockPlacement; saved: DockPlacement; expected: DockPlacement | null; session: number; topology: string; capture: HTMLElement };
export type TabGrab = { window: WindowId; point: Point };
type Outcome = { draft: DockPlacement; next: DockPlacement; preview: DockPlan; guides: Guides; atMinimum: boolean; grab: TabGrab | null };
export const floatPanelId = (id: WindowId) => `float-panel-${id}`;
export const focusTab = (id: WindowId) => requestAnimationFrame(() => focusWithoutActivation(document.getElementById(`window-tab-${id}`) ?? document.querySelector<HTMLElement>(`[data-window-header="${id}"]`)));

function choose(id: WindowId) {
  touchWindow(id);
  if (useLayoutStore.getState().layout.windows.some((window) => window.id === id && window.kind === "chart")) useSelectionStore.getState().setActiveCell(id);
}

export function useDockInteraction({ root, dock, saved, space, enabled, onPick }: { root: RefObject<HTMLElement | null>; dock: DockPlacement; saved: DockPlacement; space: DockSpace | null; enabled: boolean; onPick(window: WindowId): void }) {
  const current = useRef({ dock, saved, space, enabled, onPick });
  current.current = { dock, saved, space, enabled, onPick };
  const selectTab = (id: WindowId) => {
    current.current.onPick(id);
    useLayoutStore.getState().selectTab(id);
    choose(id);
  };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const dragging = activeDrag !== null;
  const dragCursor: GestureCursor | null = activeDrag
    ? activeDrag.operation.kind === "float-resize"
      ? RESIZE_CURSOR[activeDrag.operation.handle]
      : "grabbing"
    : null;
  const activeResize = activeDrag?.operation.kind === "float-resize" ? { window: activeDrag.window, handle: activeDrag.operation.handle } : null;
  const session = useLayoutStore((s) => s.session);
  const windows = useLayoutStore((s) => s.layout.windows);
  const topology = topologyOf(windows);

  useLayoutEffect(() => {
    const rootElement = document.documentElement;
    if (dragCursor) rootElement.dataset.dockCursor = dragCursor;
    else delete rootElement.dataset.dockCursor;
    return () => {
      delete rootElement.dataset.dockCursor;
    };
  }, [dragCursor]);

  const valid = (start: Start) => {
    const state = useLayoutStore.getState();
    const latest = current.current;
    return latest.enabled && useUiStore.getState().prefs.layoutMode === "dock" && state.session === start.session && state.layout.placement.dock === start.expected && latest.space !== null && root.current !== null && root.current.clientWidth > 0 && root.current.clientHeight > 0 && topologyOf(state.layout.windows) === start.topology && (start.operation.kind === "tab" || (latest.space?.area.w === start.area.w && latest.space.area.h === start.area.h && root.current?.clientWidth === start.area.w && root.current.clientHeight === start.area.h));
  };

  const evaluate = (start: Start, point: Point, shift: boolean): Outcome => {
    const room = current.current.space!;
    const area = start.operation.kind === "tab" ? workArea(root.current!.clientWidth, root.current!.clientHeight)! : start.area;
    const currentRoom = start.operation.kind === "tab" ? { ...room, area } : room;
    const idle: Outcome = { draft: start.dock, next: start.saved, preview: { kind: "unchanged" }, guides: NO_GUIDES, atMinimum: false, grab: start.operation.kind === "tab" ? { window: start.window.id, point } : null };
    if (start.operation.kind === "tab" && shift) {
      const bounds = root.current!.getBoundingClientRect();
      const rect = detachedRect(start.dock, start.window.id, currentRoom, area, { x: point.x - bounds.left, y: point.y - bounds.top })!;
      const next = detachWindow(start.dock, start.window.id, rect);
      return next === start.dock ? { ...idle, preview: { kind: "blocked", rect: toPx(rect, area), label: LAST_DOCKED_NOTICE } } : { ...idle, next: carryMove(start.saved, start.dock, next, start.window.id), preview: { kind: "change", dock: next, rect: toPx(rect, area), label: "띄우기" } };
    }
    let moved = idle;
    if (start.operation.kind !== "tab") {
      const boxes = floatRects(start.dock, room.windows, start.area);
      const others = start.dock.floats.filter((float) => float.window !== start.window.id).map((float) => boxes[float.window]!);
      const offset = { x: point.x - start.point.x, y: point.y - start.point.y };
      const result = start.operation.kind === "float-move" ? { ...moveRect(start.operation.rect, offset, others, start.area), atMinimum: false } : resizeRect(start.operation.rect, start.operation.handle, offset, minWindowSize(start.window.kind, ladderRateHidden()), others, start.area);
      const next = moveFloat(frontFloat(start.dock, start.window.id), start.window.id, toRatio(result.rect, start.area));
      moved = { ...idle, draft: next, next: carryMove(start.saved, start.dock, next, start.window.id), guides: result.guides, atMinimum: result.atMinimum };
      if (shift || start.operation.kind === "float-resize") return moved;
    }
    const command = commandAt(root.current!, start.dock, start.window.id, point, currentRoom, start.point);
    const planned = command ? evaluateView({ saved: start.saved, drawn: start.dock }, command, currentRoom) : null;
    const preview = planned?.plan ?? idle.preview;
    return { ...moved, preview, next: preview.kind === "change" && planned ? planned.next : preview.kind === "blocked" ? start.saved : moved.next };
  };

  const gesture = usePointerGesture<Start>({
    className: "dock-dragging",
    classOnPress: false,
    shieldWhilePressed: false,
    suppressOnCancel: false,
    trackShift: true,
    exceedsThreshold: (dx, dy) => Math.hypot(dx, dy) > 5,
    preventUp: (start, wasDragging) => wasDragging || start.operation.kind !== "tab",
    valid,
    onDrag(start, point, shift) {
      setOutcome(evaluate(start, point, shift));
      setActiveDrag((now) => (now?.window === start.window.id && now.operation === start.operation ? now : { window: start.window.id, operation: start.operation }));
      setMenu(null);
    },
    onFinish(start, reason) {
      setOutcome(null);
      setActiveDrag(null);
      if (reason === "cancel") focusTab(start.window.id);
    },
    onComplete(start, point, shift, wasDragging, accepted) {
      if (!accepted) return;
      const result = wasDragging ? evaluate(start, point, shift) : null;
      if (result) {
        if (result.preview.kind === "blocked") useSelectionStore.getState().showToast(result.preview.label, { tone: "warning" });
        if (result.next !== start.saved) useLayoutStore.getState().commitDock({ session: start.session, expected: start.expected, next: result.next });
        if (result.atMinimum) minimumWindowNotice(start.window);
        if (start.operation.kind !== "tab" || result.next !== start.saved) choose(start.window.id);
        focusTab(start.window.id);
      } else if (start.operation.kind === "tab") {
        selectTab(start.window.id);
      } else {
        useLayoutStore.getState().commitDock({ session: start.session, expected: start.expected, next: frontFloat(start.saved, start.window.id) });
      }
    },
  });

  const execute = (command: DockCommand) => {
    const latest = current.current;
    const state = useLayoutStore.getState();
    if (!latest.enabled || !latest.space || (state.layout.placement.dock !== null && state.layout.placement.dock !== latest.saved)) return;
    const { plan, next } = evaluateView({ saved: latest.saved, drawn: latest.dock }, command, latest.space);
    if (plan.kind === "blocked") useSelectionStore.getState().showToast(plan.label, { tone: "warning" });
    if (plan.kind === "change") { state.commitDock({ session: state.session, expected: state.layout.placement.dock, next }); choose(command.window); }
    else if (plan.kind === "unchanged" && command.kind === "tab") selectTab(command.window);
    focusTab(command.window);
  };

  useEffect(() => {
    const active = gesture.current();
    if (active.kind !== "idle" && !valid(active.start)) gesture.cancel();
    else if (active.kind === "dragging" && active.start.operation.kind === "tab") setOutcome(evaluate(active.start, active.point, active.shift));
    if (!enabled) setMenu(null);
  }, [dock, session, topology, space?.area.w, space?.area.h, enabled]);

  const press = (event: PointerEvent<HTMLElement>, window: WindowState, operation: Operation) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || gesture.current().kind !== "idle" || !space) return;
    if (operation.kind === "float-move" && isInteractiveTarget(event.target)) return;
    const area = workArea(space.area.w, space.area.h);
    const state = useLayoutStore.getState();
    if (!area || (state.layout.placement.dock !== null && state.layout.placement.dock !== saved)) return;
    const capture = operation.kind === "tab" ? root.current! : event.currentTarget;
    const start: Start = { pointer: event.pointerId, window, operation, point: { x: event.clientX, y: event.clientY }, dock, saved, expected: state.layout.placement.dock, area, session: state.session, topology: topologyOf(state.layout.windows), capture };
    focusWithoutActivation(event.currentTarget);
    gesture.begin(start);
    if (operation.kind !== "tab") { choose(window.id); setOutcome({ draft: frontFloat(dock, window.id), next: saved, preview: { kind: "unchanged" }, guides: NO_GUIDES, atMinimum: false, grab: null }); }
  };
  const openMenu = (window: WindowId, x: number, y: number) => {
    focusWithoutActivation(document.getElementById(`window-tab-${window}`));
    setMenu({ window, x, y });
  };
  const contextTab = (event: MouseEvent<HTMLButtonElement>, window: WindowId) => { event.preventDefault(); openMenu(window, event.clientX, event.clientY); };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, window: WindowId): boolean => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); openMenu(window, box.left, box.bottom); return true; }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const group = groupOfWindow(dock.root, window);
      if (group) execute({ kind: "tab", window, group: group.id, at: Math.max(0, Math.min(group.tabs.length - 1, group.tabs.indexOf(window) + (event.key === "ArrowLeft" ? -1 : 1))) });
      return true;
    }
    return false;
  };
  const detach = (window: WindowId) => {
    const state = useLayoutStore.getState();
    const area = space && workArea(space.area.w, space.area.h);
    if (!enabled || !space || !area || (state.layout.placement.dock !== null && state.layout.placement.dock !== saved)) return;
    const rect = detachedRect(dock, window, space, area);
    if (rect && state.commitDock({ session: state.session, expected: state.layout.placement.dock, next: detachWindow(saved, window, rect) })) { choose(window); focusTab(window); }
  };
  const lostCapture = (event: PointerEvent<HTMLElement>) => gesture.lostCapture(event.pointerId);
  const floatBindings = (window: WindowState): FrameBindings => {
    const area = space && workArea(space.area.w, space.area.h);
    const rect = area && floatRects(saved, space!.windows, area)[window.id];
    return {
      activate: (event) => {
        if (!enabled || gesture.current().kind !== "idle") return;
        const target = event.target;
        if (target instanceof Element && (target.closest("[data-resize-handle]") || (target.closest("[data-window-header]") && !target.closest("button")))) return;
        choose(window.id);
        if (target instanceof Element && target.closest(".window-action")) return;
        useLayoutStore.getState().commitDock({ session, expected: saved, next: frontFloat(saved, window.id) });
      },
      header: {
        onFocus: (event) => {
          if (!enabled || isProgrammaticFocus(event.target) || !(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible") || gesture.current().kind !== "idle") return;
          const state = useLayoutStore.getState();
          const expected = state.layout.placement.dock;
          if (!expected) return;
          choose(window.id);
          state.commitDock({ session: state.session, expected, next: frontFloat(expected, window.id) });
        },
        onPointerDown: (event) => { if (rect) press(event, window, { kind: "float-move", rect }); },
        onLostPointerCapture: lostCapture,
        onKeyDown: (event) => {
          if (!enabled || event.target !== event.currentTarget || !area || !rect) return;
          if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); closeWindow(window.id, windowName(useLayoutStore.getState().layout.windows, window)); return; }
          const offset = ARROWS[event.key];
          if (!offset || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          const boxes = floatRects(saved, space!.windows, area);
          const others = saved.floats.filter((float) => float.window !== window.id).map((float) => boxes[float.window]!);
          const result = applyArrowGeometry(rect, window, others, area, offset, event.shiftKey);
          useLayoutStore.getState().commitDock({ session, expected: saved, next: moveFloat(frontFloat(saved, window.id), window.id, toRatio(result.rect, area)) });
          choose(window.id);
          if (result.atMinimum) minimumWindowNotice(window);
        },
      },
      resize: (handle) => (event) => { if (rect) press(event, window, { kind: "float-resize", rect, handle }); },
    };
  };
  return { grab: outcome?.grab ?? null, grabbed: outcome?.grab?.window ?? null, shown: outcome?.draft ?? dock, guides: outcome?.guides ?? NO_GUIDES, dragging, dragCursor, activeResize, preview: outcome?.preview ?? null, menu, setMenu, execute, detach, canDetach: (window: WindowId) => canDetach(dock, window), plan: (command: DockCommand): DockPlan => (space ? evaluateView({ saved, drawn: dock }, command, space).plan : { kind: "unchanged" }), floatBindings, pressTab: (event: PointerEvent<HTMLButtonElement>, id: WindowId) => { const window = windows.find((window) => window.id === id); if (window) press(event, window, { kind: "tab" }); }, contextTab, keyTab, selectTab, lostCapture };
}

export type DockInteraction = ReturnType<typeof useDockInteraction>;
