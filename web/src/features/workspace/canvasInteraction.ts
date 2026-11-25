import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { bringToFront, rectsForArea } from "../../layout/canvas/arrange";
import { minWindowSize, toRatio, type Area } from "../../layout/canvas/geometry";
import { moveRect, resizeRect, type ResizeHandle } from "../../layout/canvas/snap";
import type { WindowId, WindowRef } from "../../layout/kinds";
import type { CanvasPlacement, Rect } from "../../layout/placement";
import { useLayoutStore, windowName, type WindowState } from "../../stores/layout";
import { ladderRateHidden, useUiStore } from "../../stores/ui";
import { useSelectionStore } from "../../stores/selection";
import { closeWindow } from "./manage";
import { focusWithoutActivation, isProgrammaticFocus } from "./focus";
import type { FrameBindings } from "./WindowFrame";
import {
  applyArrowGeometry,
  ARROWS,
  isInteractiveTarget,
  minimumWindowNotice,
  NO_GUIDES,
  type Point,
  topologyOf,
  usePointerGesture,
} from "./windowGesture";

type Operation = { kind: "move" } | { kind: "resize"; handle: ResizeHandle };
type Start = { pointer: number; window: WindowState; operation: Operation; point: Point; rect: Rect; area: Area; expected: CanvasPlacement; session: number; topology: string; capture: HTMLElement };
type PendingCanvas = { next: CanvasPlacement; atMinimum: boolean };
type Maximization = { window: WindowId; base: CanvasPlacement };
export const canvasPanelId = (id: WindowId) => `canvas-panel-${id}`;

export function useCanvasInteraction(canvas: CanvasPlacement, windows: readonly WindowState[], refs: readonly WindowRef[], area: Area) {
  const latest = useRef({ canvas, windows, refs, area });
  latest.current = { canvas, windows, refs, area };
  const pendingRef = useRef<PendingCanvas | null>(null);
  const [draft, setDraft] = useState<CanvasPlacement | null>(null);
  const [guides, setGuides] = useState(NO_GUIDES);
  const [dragging, setDragging] = useState(false);
  const [maximization, setMaximization] = useState<Maximization | null>(null);
  const maximized = maximization?.base === canvas ? maximization.window : null;
  const session = useLayoutStore((s) => s.session);
  const topology = topologyOf(windows);

  const valid = (start: Start) => {
    const state = useLayoutStore.getState();
    const now = latest.current;
    const stage = start.capture.closest<HTMLElement>("[data-canvas-stage]");
    return stage?.clientWidth === start.area.w && stage.clientHeight === start.area.h && useUiStore.getState().prefs.layoutMode === "canvas" && state.canvasArea?.w === start.area.w && state.canvasArea.h === start.area.h && state.session === start.session && state.layout.placement.canvas === start.expected && topologyOf(state.layout.windows) === start.topology && now.area.w === start.area.w && now.area.h === start.area.h;
  };

  const gesture = usePointerGesture<Start>({
    className: "canvas-gesturing",
    classOnPress: true,
    shieldWhilePressed: true,
    suppressOnCancel: true,
    exceedsThreshold: (dx, dy) => Math.hypot(dx, dy) >= 4,
    valid,
    onDrag(start, point) {
      const offset = { x: point.x - start.point.x, y: point.y - start.point.y };
      const boxes = rectsForArea(start.expected, latest.current.refs, start.area);
      const others = latest.current.windows.filter((window) => window.id !== start.window.id).map((window) => boxes[window.id]!);
      const result = start.operation.kind === "move" ? { ...moveRect(start.rect, offset, others, start.area), atMinimum: false } : resizeRect(start.rect, start.operation.handle, offset, minWindowSize(start.window.kind, ladderRateHidden()), others, start.area);
      const front = bringToFront(start.expected, start.window.id);
      const next = { ...front, rects: { ...front.rects, [start.window.id]: toRatio(result.rect, start.area) } };
      pendingRef.current = { next, atMinimum: result.atMinimum };
      setDraft(next);
      setGuides(result.guides);
      setDragging(true);
    },
    onFinish(_start, reason) {
      setDraft(null);
      setGuides(NO_GUIDES);
      setDragging(false);
      if (reason === "cancel") pendingRef.current = null;
    },
    onComplete(start, _point, _shift, wasDragging, accepted) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!accepted || !pending) return;
      useLayoutStore.getState().commitCanvas({ session: start.session, expected: start.expected, next: pending.next });
      if (wasDragging && pending.atMinimum) minimumWindowNotice(start.window);
    },
    onIdleEscape: maximized ? () => setMaximization(null) : undefined,
  });

  useEffect(() => {
    const active = gesture.current();
    if (active.kind !== "idle" && !valid(active.start)) gesture.cancel();
    if (maximization && maximization.base !== canvas) setMaximization(null);
  }, [canvas, session, topology, area.w, area.h, maximization, windows]);

  useEffect(() => { setMaximization(null); }, [session, topology]);

  const choose = (window: WindowState) => { if (window.kind === "chart") useSelectionStore.getState().setActiveCell(window.id); };
  const toggleMaximize = (window: WindowState) => {
    gesture.cancel();
    const state = useLayoutStore.getState();
    const expected = state.layout.placement.canvas;
    if (!expected) return;
    const base = bringToFront(expected, window.id);
    if (!state.commitCanvas({ session: state.session, expected, next: base })) return;
    choose(window);
    setMaximization((current) => current?.window === window.id && current.base === base ? null : { window: window.id, base });
    focusWithoutActivation(document.querySelector<HTMLElement>(`[data-window-header="${window.id}"]`));
  };
  const press = (event: PointerEvent<HTMLDivElement>, window: WindowState, operation: Operation) => {
    if (event.button !== 0 || !event.isPrimary || maximized || gesture.current().kind !== "idle") return;
    if (operation.kind === "move" && isInteractiveTarget(event.target)) return;
    const state = useLayoutStore.getState();
    if (state.layout.placement.canvas !== canvas) return;
    event.preventDefault();
    event.stopPropagation();
    const header = document.querySelector<HTMLElement>(`[data-window-header="${window.id}"]`);
    focusWithoutActivation(header);
    const rect = rectsForArea(canvas, refs, area)[window.id]!;
    const start: Start = { pointer: event.pointerId, window, operation, point: { x: event.clientX, y: event.clientY }, rect, area, expected: canvas, session: state.session, topology, capture: event.currentTarget };
    const next = bringToFront(canvas, window.id);
    pendingRef.current = { next, atMinimum: false };
    setDraft(next);
    gesture.begin(start);
    choose(window);
  };
  const keyHeader = (event: KeyboardEvent<HTMLDivElement>, window: WindowState) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape" && maximized) { event.preventDefault(); setMaximization(null); return; }
    if (event.key === "Enter") { event.preventDefault(); toggleMaximize(window); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); closeWindow(window.id, windowName(useLayoutStore.getState().layout.windows, window)); return; }
    const offset = ARROWS[event.key];
    if (!offset || event.altKey || event.ctrlKey || event.metaKey || maximized) return;
    event.preventDefault();
    const boxes = rectsForArea(canvas, refs, area);
    const others = windows.filter((candidate) => candidate.id !== window.id).map((candidate) => boxes[candidate.id]!);
    const result = applyArrowGeometry(boxes[window.id]!, window, others, area, offset, event.shiftKey);
    const front = bringToFront(canvas, window.id);
    useLayoutStore.getState().commitCanvas({ session, expected: canvas, next: { ...front, rects: { ...front.rects, [window.id]: toRatio(result.rect, area) } } });
    choose(window);
    if (result.atMinimum) minimumWindowNotice(window);
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
        if (isProgrammaticFocus(event.target) || !(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible") || gesture.current().kind !== "idle") return;
        const state = useLayoutStore.getState();
        const expected = state.layout.placement.canvas;
        if (!expected) return;
        choose(window);
        state.commitCanvas({ session: state.session, expected, next: bringToFront(expected, window.id) });
      },
      onPointerDown: (event) => press(event, window, { kind: "move" }),
      onDoubleClick: (event) => { if (!(event.target instanceof Element && event.target.closest("button"))) toggleMaximize(window); },
      onKeyDown: (event) => keyHeader(event, window),
      onLostPointerCapture: () => gesture.cancel(),
    },
    resize: (handle) => (event) => press(event, window, { kind: "resize", handle }),
  });
  return { shown: draft ?? canvas, guides, dragging, maximized, toggleMaximize, bindings };
}
