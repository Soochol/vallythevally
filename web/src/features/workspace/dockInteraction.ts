import { type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import { minWindowSize, toPx, toRatio, workArea, type Area } from "../../layout/canvas/geometry";
import { moveRect, resizeRect, type Guides, type ResizeHandle } from "../../layout/canvas/snap";
import { canDetach, detachedRect, detachWindow, floatRects, frontFloat, LAST_DOCKED_NOTICE, moveFloat } from "../../layout/dock/floats";
import type { DockSpace } from "../../layout/dock/geometry";
import { groupOfWindow } from "../../layout/dock/tree";
import { WINDOW_KINDS, type WindowId } from "../../layout/kinds";
import type { DockPlacement, Rect } from "../../layout/placement";
import { useLayoutStore, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { commandAt, evaluateDock, type DockCommand, type DockPlan } from "./dockCommands";
import { closeWindow } from "./manage";
import type { FrameBindings } from "./WindowFrame";

export type TabMenu = { window: WindowId; x: number; y: number };
type Point = { x: number; y: number };
type Operation = { kind: "tab" } | { kind: "float-move"; rect: Rect } | { kind: "float-resize"; rect: Rect; handle: ResizeHandle };
type Start = { pointer: number; window: WindowState; operation: Operation; point: Point; area: Area; dock: DockPlacement; expected: DockPlacement | null; session: number; topology: string; capture: HTMLElement };
type Outcome = { draft: DockPlacement; next: DockPlacement; preview: DockPlan; guides: Guides; atMinimum: boolean };
type Gesture = { kind: "idle" } | { kind: "pressed"; start: Start } | { kind: "dragging"; start: Start; point: Point; shift: boolean };
const NO_GUIDES: Guides = { x: null, y: null };
const ARROWS: Record<string, Point> = { ArrowLeft: { x: -16, y: 0 }, ArrowRight: { x: 16, y: 0 }, ArrowUp: { x: 0, y: -16 }, ArrowDown: { x: 0, y: 16 } };
const topologyOf = (windows: readonly WindowState[]) => windows.map((window) => window.id).join("\n");
export const floatPanelId = (id: WindowId) => `float-panel-${id}`;
export const focusTab = (id: WindowId) => requestAnimationFrame(() => (document.getElementById(`window-tab-${id}`) ?? document.querySelector<HTMLElement>(`[data-window-header="${id}"]`))?.focus({ preventScroll: true }));

function choose(id: WindowId) {
  if (useLayoutStore.getState().layout.windows.some((window) => window.id === id && window.kind === "chart")) useSelectionStore.getState().setActiveCell(id);
}
function selectTab(id: WindowId) {
  useLayoutStore.getState().selectTab(id);
  choose(id);
}
function minimumNotice(window: WindowState) {
  const min = minWindowSize(window.kind);
  useSelectionStore.getState().showToast(`${WINDOW_KINDS[window.kind].name} 창은 ${min.w}×${min.h}보다 작게 줄일 수 없습니다`);
}

export function useDockInteraction({ root, dock, space, enabled }: { root: RefObject<HTMLElement | null>; dock: DockPlacement; space: DockSpace | null; enabled: boolean }) {
  const gesture = useRef<Gesture>({ kind: "idle" });
  const current = useRef({ dock, space, enabled });
  current.current = { dock, space, enabled };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const suppressedPointer = useRef<number | null>(null);
  const session = useLayoutStore((s) => s.session);
  const windows = useLayoutStore((s) => s.layout.windows);
  const topology = topologyOf(windows);

  const finish = (restoreFocus: boolean) => {
    const previous = gesture.current;
    gesture.current = { kind: "idle" };
    setOutcome(null);
    setDragging(false);
    document.documentElement.classList.remove("dock-dragging");
    if (previous.kind === "idle") return;
    if (previous.kind === "dragging") suppressedPointer.current = previous.start.pointer;
    if (previous.start.capture.hasPointerCapture(previous.start.pointer)) previous.start.capture.releasePointerCapture(previous.start.pointer);
    if (restoreFocus) focusTab(previous.start.window.id);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const valid = (start: Start) => {
    const state = useLayoutStore.getState();
    const latest = current.current;
    return latest.enabled && useUiStore.getState().prefs.layoutMode === "dock" && state.session === start.session && state.layout.placement.dock === start.expected && latest.space !== null && root.current !== null && root.current.clientWidth > 0 && root.current.clientHeight > 0 && topologyOf(state.layout.windows) === start.topology && (start.operation.kind === "tab" || (latest.space?.area.w === start.area.w && latest.space.area.h === start.area.h && root.current?.clientWidth === start.area.w && root.current.clientHeight === start.area.h));
  };
  const validRef = useRef(valid);
  validRef.current = valid;
  const evaluate = (start: Start, point: Point, shift: boolean): Outcome => {
    const room = current.current.space!;
    const area = start.operation.kind === "tab" ? workArea(root.current!.clientWidth, root.current!.clientHeight)! : start.area;
    const currentRoom = start.operation.kind === "tab" ? { ...room, area } : room;
    const idle: Outcome = { draft: start.dock, next: start.dock, preview: { kind: "unchanged" }, guides: NO_GUIDES, atMinimum: false };
    if (start.operation.kind === "tab" && shift) {
      const bounds = root.current!.getBoundingClientRect();
      const rect = detachedRect(start.dock, start.window.id, currentRoom, area, { x: point.x - bounds.left, y: point.y - bounds.top })!;
      const next = detachWindow(start.dock, start.window.id, rect);
      return { ...idle, next, preview: next === start.dock ? { kind: "blocked", rect: toPx(rect, area), label: LAST_DOCKED_NOTICE } : { kind: "change", dock: next, rect: toPx(rect, area), label: "띄우기" } };
    }
    let moved = idle;
    if (start.operation.kind !== "tab") {
      const boxes = floatRects(start.dock, room.windows, start.area);
      const others = start.dock.floats.filter((float) => float.window !== start.window.id).map((float) => boxes[float.window]!);
      const offset = { x: point.x - start.point.x, y: point.y - start.point.y };
      const result = start.operation.kind === "float-move" ? { ...moveRect(start.operation.rect, offset, others, start.area), atMinimum: false } : resizeRect(start.operation.rect, start.operation.handle, offset, minWindowSize(start.window.kind), others, start.area);
      const next = moveFloat(frontFloat(start.dock, start.window.id), start.window.id, toRatio(result.rect, start.area));
      moved = { ...idle, draft: next, next, guides: result.guides, atMinimum: result.atMinimum };
      if (shift || start.operation.kind === "float-resize") return moved;
    }
    const command = commandAt(root.current!, start.dock, start.window.id, point, currentRoom, start.point);
    const preview = command ? evaluateDock(start.dock, command, currentRoom) : idle.preview;
    return { ...moved, preview, next: preview.kind === "change" ? preview.dock : preview.kind === "blocked" ? start.dock : moved.next };
  };
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;

  const execute = (command: DockCommand) => {
    const latest = current.current;
    const state = useLayoutStore.getState();
    if (!latest.enabled || !latest.space || (state.layout.placement.dock !== null && state.layout.placement.dock !== latest.dock)) return;
    const plan = evaluateDock(latest.dock, command, latest.space);
    if (plan.kind === "blocked") useSelectionStore.getState().showToast(plan.label);
    if (plan.kind === "change") { state.commitDock({ session: state.session, expected: state.layout.placement.dock, next: plan.dock }); choose(command.window); }
    else if (plan.kind === "unchanged" && command.kind === "tab") selectTab(command.window);
    focusTab(command.window);
  };

  useEffect(() => {
    const update = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
      if (!validRef.current(active.start)) { finishRef.current(true); return; }
      if (active.kind === "pressed" && Math.hypot(event.clientX - active.start.point.x, event.clientY - active.start.point.y) <= 5) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const point = { x: event.clientX, y: event.clientY };
      gesture.current = { kind: "dragging", start: active.start, point, shift: event.shiftKey };
      setOutcome(evaluateRef.current(active.start, point, event.shiftKey));
      setDragging(true);
      setMenu(null);
      document.documentElement.classList.add("dock-dragging");
    };
    const up = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
      const accepted = validRef.current(active.start);
      const result = accepted && active.kind === "dragging" ? evaluateRef.current(active.start, { x: event.clientX, y: event.clientY }, event.shiftKey) : null;
      if (active.kind === "dragging" || active.start.operation.kind !== "tab") { event.preventDefault(); event.stopImmediatePropagation(); }
      finishRef.current(false);
      if (!accepted) return;
      if (result) {
        if (result.preview.kind === "blocked") useSelectionStore.getState().showToast(result.preview.label);
        if (result.next !== active.start.dock) useLayoutStore.getState().commitDock({ session: active.start.session, expected: active.start.expected, next: result.next });
        if (result.atMinimum) minimumNotice(active.start.window);
        if (active.start.operation.kind !== "tab" || result.next !== active.start.dock) choose(active.start.window.id);
        focusTab(active.start.window.id);
      } else if (active.start.operation.kind === "tab") selectTab(active.start.window.id);
      else useLayoutStore.getState().commitDock({ session: active.start.session, expected: active.start.expected, next: frontFloat(active.start.dock, active.start.window.id) });
    };
    const cancel = () => { if (gesture.current.kind !== "idle") finishRef.current(true); };
    const cancelPointer = (event: globalThis.PointerEvent) => { const active = gesture.current; if (active.kind !== "idle" && active.start.pointer === event.pointerId) cancel(); };
    const key = (event: globalThis.KeyboardEvent) => {
      const active = gesture.current;
      if (active.kind === "idle") return;
      if (!validRef.current(active.start)) { cancel(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
      else if (active.kind === "dragging") {
        if (event.key === "Shift") {
          gesture.current = { ...active, shift: event.type === "keydown" };
          setOutcome(evaluateRef.current(active.start, active.point, event.type === "keydown"));
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const shield = (event: Event) => {
      if (event.type === "pointerdown" && event instanceof globalThis.PointerEvent && event.pointerId === suppressedPointer.current) suppressedPointer.current = null;
      const trailing = event.type === "click" && event instanceof globalThis.PointerEvent && event.pointerId === suppressedPointer.current && event.detail > 0;
      if (trailing) suppressedPointer.current = null;
      if (gesture.current.kind !== "dragging" && !trailing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointermove", update, { capture: true, passive: false });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    const blocked = ["pointerdown", "click", "dblclick", "contextmenu", "wheel"];
    blocked.forEach((type) => document.addEventListener(type, shield, { capture: true, passive: false }));
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("pointermove", update, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancelPointer, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      blocked.forEach((type) => document.removeEventListener(type, shield, true));
      window.removeEventListener("blur", cancel);
    };
  }, []);

  useEffect(() => {
    const active = gesture.current;
    if (active.kind !== "idle" && !validRef.current(active.start)) finishRef.current(true);
    else if (active.kind === "dragging" && active.start.operation.kind === "tab") setOutcome(evaluateRef.current(active.start, active.point, active.shift));
    if (!enabled) setMenu(null);
  }, [dock, session, topology, space?.area.w, space?.area.h, enabled]);

  const press = (event: PointerEvent<HTMLElement>, window: WindowState, operation: Operation) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || gesture.current.kind !== "idle" || !space) return;
    if (operation.kind === "float-move" && event.target instanceof Element && event.target.closest("button, input, a, select")) return;
    const area = workArea(space.area.w, space.area.h);
    const state = useLayoutStore.getState();
    if (!area || (state.layout.placement.dock !== null && state.layout.placement.dock !== dock)) return;
    const capture = operation.kind === "tab" ? root.current! : event.currentTarget;
    gesture.current = { kind: "pressed", start: { pointer: event.pointerId, window, operation, point: { x: event.clientX, y: event.clientY }, dock, expected: state.layout.placement.dock, area, session: state.session, topology: topologyOf(state.layout.windows), capture } };
    event.currentTarget.focus({ preventScroll: true });
    capture.setPointerCapture(event.pointerId);
    if (operation.kind !== "tab") { choose(window.id); setOutcome({ draft: frontFloat(dock, window.id), next: dock, preview: { kind: "unchanged" }, guides: NO_GUIDES, atMinimum: false }); }
  };
  const openMenu = (window: WindowId, x: number, y: number) => {
    document.getElementById(`window-tab-${window}`)?.focus();
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
    if (!enabled || !space || !area || (state.layout.placement.dock !== null && state.layout.placement.dock !== dock)) return;
    const rect = detachedRect(dock, window, space, area);
    if (rect && state.commitDock({ session: state.session, expected: state.layout.placement.dock, next: detachWindow(dock, window, rect) })) { choose(window); focusTab(window); }
  };
  const lostCapture = (event: PointerEvent<HTMLElement>) => { const active = gesture.current; if (active.kind !== "idle" && active.start.pointer === event.pointerId) finishRef.current(true); };
  const floatBindings = (window: WindowState): FrameBindings => {
    const area = space && workArea(space.area.w, space.area.h);
    const rect = area && floatRects(dock, space!.windows, area)[window.id];
    return {
      activate: (event) => {
        if (!enabled || gesture.current.kind !== "idle") return;
        const target = event.target;
        if (target instanceof Element && (target.closest("[data-resize-handle]") || (target.closest("[data-window-header]") && !target.closest("button")))) return;
        choose(window.id);
        if (target instanceof Element && target.closest(".window-action")) return;
        useLayoutStore.getState().commitDock({ session, expected: dock, next: frontFloat(dock, window.id) });
      },
      header: {
        onPointerDown: (event) => { if (rect) press(event, window, { kind: "float-move", rect }); },
        onLostPointerCapture: lostCapture,
        onKeyDown: (event) => {
          if (!enabled || event.target !== event.currentTarget || !area || !rect) return;
          if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); closeWindow(window.id, WINDOW_KINDS[window.kind].name); return; }
          const offset = ARROWS[event.key];
          if (!offset || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          const boxes = floatRects(dock, space!.windows, area);
          const others = dock.floats.filter((float) => float.window !== window.id).map((float) => boxes[float.window]!);
          const result = event.shiftKey ? resizeRect(rect, offset.x ? "e" : "s", offset, minWindowSize(window.kind), others, area) : { ...moveRect(rect, offset, others, area), atMinimum: false };
          useLayoutStore.getState().commitDock({ session, expected: dock, next: moveFloat(frontFloat(dock, window.id), window.id, toRatio(result.rect, area)) });
          choose(window.id);
          if (result.atMinimum) minimumNotice(window);
        },
      },
      resize: (handle) => (event) => { if (rect) press(event, window, { kind: "float-resize", rect, handle }); },
    };
  };
  return { shown: outcome?.draft ?? dock, guides: outcome?.guides ?? NO_GUIDES, dragging, preview: outcome?.preview ?? null, menu, setMenu, execute, detach, canDetach: (window: WindowId) => canDetach(dock, window), floatBindings, pressTab: (event: PointerEvent<HTMLButtonElement>, id: WindowId) => { const window = windows.find((window) => window.id === id); if (window) press(event, window, { kind: "tab" }); }, contextTab, keyTab, selectTab, lostCapture };
}

export type DockInteraction = ReturnType<typeof useDockInteraction>;
