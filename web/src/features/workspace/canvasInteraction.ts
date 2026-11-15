import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { bringToFront, rectsForArea } from "../../layout/canvas/arrange";
import { minWindowSize, toRatio, type Area } from "../../layout/canvas/geometry";
import { moveRect, resizeRect, type Guides, type ResizeHandle } from "../../layout/canvas/snap";
import { WINDOW_KINDS, type WindowId } from "../../layout/kinds";
import type { CanvasPlacement, Rect } from "../../layout/placement";
import { useLayoutStore, type WindowState } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { useSelectionStore } from "../../stores/selection";
import { closeWindow } from "./manage";
import type { FrameBindings } from "./WindowFrame";

type Operation = { kind: "move" } | { kind: "resize"; handle: ResizeHandle };
type Start = { pointer: number; window: WindowState; operation: Operation; point: { x: number; y: number }; rect: Rect; area: Area; expected: CanvasPlacement; session: number; topology: string; capture: HTMLElement };
type Gesture = { kind: "idle" } | { kind: "pressed"; start: Start; next: CanvasPlacement } | { kind: "dragging"; start: Start; next: CanvasPlacement; atMinimum: boolean };
type Maximization = { window: WindowId; base: CanvasPlacement };
const NO_GUIDES: Guides = { x: null, y: null };
const ARROWS: Record<string, { x: number; y: number }> = { ArrowLeft: { x: -16, y: 0 }, ArrowRight: { x: 16, y: 0 }, ArrowUp: { x: 0, y: -16 }, ArrowDown: { x: 0, y: 16 } };
const topologyOf = (windows: readonly WindowState[]) => windows.map((window) => window.id).join("\n");
export const canvasPanelId = (id: WindowId) => `canvas-panel-${id}`;

export function useCanvasInteraction(canvas: CanvasPlacement, windows: readonly WindowState[], area: Area) {
  const gesture = useRef<Gesture>({ kind: "idle" });
  const latest = useRef({ canvas, windows, area });
  latest.current = { canvas, windows, area };
  const [draft, setDraft] = useState<CanvasPlacement | null>(null);
  const [guides, setGuides] = useState(NO_GUIDES);
  const [dragging, setDragging] = useState(false);
  const [maximization, setMaximization] = useState<Maximization | null>(null);
  const maximized = maximization?.base === canvas ? maximization.window : null;
  const maximizedRef = useRef(maximized);
  maximizedRef.current = maximized;
  const suppressedPointer = useRef<number | null>(null);
  const session = useLayoutStore((s) => s.session);
  const topology = topologyOf(windows);

  const finish = (suppress: boolean) => {
    const active = gesture.current;
    gesture.current = { kind: "idle" };
    setDraft(null);
    setGuides(NO_GUIDES);
    setDragging(false);
    document.documentElement.classList.remove("canvas-gesturing");
    if (active.kind === "idle") return;
    if (suppress) suppressedPointer.current = active.start.pointer;
    if (active.start.capture.hasPointerCapture(active.start.pointer)) active.start.capture.releasePointerCapture(active.start.pointer);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const valid = (start: Start) => {
    const state = useLayoutStore.getState();
    const now = latest.current;
    const stage = start.capture.closest<HTMLElement>("[data-canvas-stage]");
    return stage?.clientWidth === start.area.w && stage.clientHeight === start.area.h && useUiStore.getState().prefs.layoutMode === "canvas" && state.canvasArea?.w === start.area.w && state.canvasArea.h === start.area.h && state.session === start.session && state.layout.placement.canvas === start.expected && topologyOf(state.layout.windows) === start.topology && now.area.w === start.area.w && now.area.h === start.area.h;
  };
  const validRef = useRef(valid);
  validRef.current = valid;
  const minimumNotice = (window: WindowState) => {
    const min = minWindowSize(window.kind);
    useSelectionStore.getState().showToast(`${WINDOW_KINDS[window.kind].name} 창은 ${min.w}×${min.h}보다 작게 줄일 수 없습니다`);
  };

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!validRef.current(active.start)) { finishRef.current(true); return; }
      const offset = { x: event.clientX - active.start.point.x, y: event.clientY - active.start.point.y };
      if (active.kind === "pressed" && Math.hypot(offset.x, offset.y) < 4) return;
      const { start } = active;
      const boxes = rectsForArea(start.expected, latest.current.windows, start.area);
      const others = latest.current.windows.filter((window) => window.id !== start.window.id).map((window) => boxes[window.id]!);
      const result = start.operation.kind === "move" ? { ...moveRect(start.rect, offset, others, start.area), atMinimum: false } : resizeRect(start.rect, start.operation.handle, offset, minWindowSize(start.window.kind), others, start.area);
      const front = bringToFront(start.expected, start.window.id);
      const next = { ...front, rects: { ...front.rects, [start.window.id]: toRatio(result.rect, start.area) } };
      gesture.current = { kind: "dragging", start, next, atMinimum: result.atMinimum };
      setDraft(next);
      setGuides(result.guides);
      setDragging(true);
    };
    const up = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const accepted = validRef.current(active.start);
      finishRef.current(active.kind === "dragging");
      if (!accepted) return;
      useLayoutStore.getState().commitCanvas({ session: active.start.session, expected: active.start.expected, next: active.next });
      if (active.kind === "dragging" && active.atMinimum) minimumNotice(active.start.window);
    };
    const cancel = () => { if (gesture.current.kind !== "idle") finishRef.current(true); };
    const cancelPointer = (event: globalThis.PointerEvent) => { const active = gesture.current; if (active.kind !== "idle" && active.start.pointer === event.pointerId) cancel(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (gesture.current.kind === "idle") {
        if (event.key === "Escape" && maximizedRef.current) { event.preventDefault(); event.stopImmediatePropagation(); setMaximization(null); }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") cancel();
    };
    const shield = (event: Event) => {
      if (event.type === "pointerdown" && gesture.current.kind === "idle") suppressedPointer.current = null;
      const trailing = event.type === "click" && event instanceof globalThis.PointerEvent && event.pointerId === suppressedPointer.current && event.detail > 0;
      if (trailing) suppressedPointer.current = null;
      if (gesture.current.kind === "idle" && !trailing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    document.addEventListener("keydown", key, true);
    const blocked = ["pointerdown", "click", "dblclick", "contextmenu", "wheel"];
    blocked.forEach((type) => document.addEventListener(type, shield, { capture: true, passive: false }));
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancelPointer, true);
      document.removeEventListener("keydown", key, true);
      blocked.forEach((type) => document.removeEventListener(type, shield, true));
      window.removeEventListener("blur", cancel);
    };
  }, []);

  useEffect(() => {
    const active = gesture.current;
    if (active.kind !== "idle" && !valid(active.start)) finishRef.current(true);
    if (maximization && maximization.base !== canvas) setMaximization(null);
  }, [canvas, session, topology, area.w, area.h, maximization, windows]);

  useEffect(() => { setMaximization(null); }, [session, topology]);

  const choose = (window: WindowState) => { if (window.kind === "chart") useSelectionStore.getState().setActiveCell(window.id); };
  const toggleMaximize = (window: WindowState) => {
    finishRef.current(true);
    const state = useLayoutStore.getState();
    const expected = state.layout.placement.canvas;
    if (!expected) return;
    const base = bringToFront(expected, window.id);
    if (!state.commitCanvas({ session: state.session, expected, next: base })) return;
    choose(window);
    setMaximization((current) => current?.window === window.id && current.base === base ? null : { window: window.id, base });
    document.querySelector<HTMLElement>(`[data-window-header="${window.id}"]`)?.focus({ preventScroll: true });
  };
  const press = (event: PointerEvent<HTMLDivElement>, window: WindowState, operation: Operation) => {
    if (event.button !== 0 || !event.isPrimary || maximized || gesture.current.kind !== "idle") return;
    if (operation.kind === "move" && event.target instanceof Element && event.target.closest("button, input, a, select")) return;
    const state = useLayoutStore.getState();
    if (state.layout.placement.canvas !== canvas) return;
    event.preventDefault();
    event.stopPropagation();
    const header = document.querySelector<HTMLElement>(`[data-window-header="${window.id}"]`);
    header?.focus({ preventScroll: true });
    const rect = rectsForArea(canvas, windows, area)[window.id]!;
    const start: Start = { pointer: event.pointerId, window, operation, point: { x: event.clientX, y: event.clientY }, rect, area, expected: canvas, session: state.session, topology, capture: event.currentTarget };
    const next = bringToFront(canvas, window.id);
    gesture.current = { kind: "pressed", start, next };
    setDraft(next);
    document.documentElement.classList.add("canvas-gesturing");
    event.currentTarget.setPointerCapture(event.pointerId);
    choose(window);
  };
  const keyHeader = (event: KeyboardEvent<HTMLDivElement>, window: WindowState) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape" && maximized) { event.preventDefault(); setMaximization(null); return; }
    if (event.key === "Enter") { event.preventDefault(); toggleMaximize(window); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); closeWindow(window.id, WINDOW_KINDS[window.kind].name); return; }
    const offset = ARROWS[event.key];
    if (!offset || event.altKey || event.ctrlKey || event.metaKey || maximized) return;
    event.preventDefault();
    const boxes = rectsForArea(canvas, windows, area);
    const others = windows.filter((candidate) => candidate.id !== window.id).map((candidate) => boxes[candidate.id]!);
    const result = event.shiftKey ? resizeRect(boxes[window.id]!, offset.x ? "e" : "s", offset, minWindowSize(window.kind), others, area) : { ...moveRect(boxes[window.id]!, offset, others, area), atMinimum: false };
    const front = bringToFront(canvas, window.id);
    useLayoutStore.getState().commitCanvas({ session, expected: canvas, next: { ...front, rects: { ...front.rects, [window.id]: toRatio(result.rect, area) } } });
    choose(window);
    if (result.atMinimum) minimumNotice(window);
  };
  const bindings = (window: WindowState): FrameBindings => ({
    activate: (event) => {
      const target = event.target;
      if (target instanceof Element && (target.closest("[data-resize-handle]") || (target.closest("[data-window-header]") && !target.closest("button")))) return;
      choose(window);
      const state = useLayoutStore.getState();
      state.commitCanvas({ session: state.session, expected: canvas, next: bringToFront(canvas, window.id) });
    },
    header: {
      onFocus: (event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible") || gesture.current.kind !== "idle") return;
        const state = useLayoutStore.getState();
        const expected = state.layout.placement.canvas;
        if (!expected) return;
        choose(window);
        state.commitCanvas({ session: state.session, expected, next: bringToFront(expected, window.id) });
      },
      onPointerDown: (event) => press(event, window, { kind: "move" }),
      onDoubleClick: (event) => { if (!(event.target instanceof Element && event.target.closest("button"))) toggleMaximize(window); },
      onKeyDown: (event) => keyHeader(event, window),
      onLostPointerCapture: () => { if (gesture.current.kind !== "idle") finishRef.current(true); },
    },
    resize: (handle) => (event) => press(event, window, { kind: "resize", handle }),
  });
  return { shown: draft ?? canvas, guides, dragging, maximized, toggleMaximize, bindings };
}
