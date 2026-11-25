import { useEffect, useRef } from "react";
import { minWindowSize, type Area } from "../../layout/canvas/geometry";
import { moveRect, resizeRect, type Guides, type ResizeHandle } from "../../layout/canvas/snap";
import type { Rect } from "../../layout/placement";
import { useLayoutStore, windowName, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { ladderRateHidden } from "../../stores/ui";
import { watchPointerCapture } from "./pointerCapture";

export type Point = { x: number; y: number };

export const NO_GUIDES: Guides = { x: null, y: null };

export const ARROWS: Readonly<Record<string, Point>> = {
  ArrowLeft: { x: -16, y: 0 },
  ArrowRight: { x: 16, y: 0 },
  ArrowUp: { x: 0, y: -16 },
  ArrowDown: { x: 0, y: 16 },
};

export const topologyOf = (windows: readonly WindowState[]): string => windows.map((window) => window.id).join("\n");

export const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest("button, input, a, select") !== null;

export function minimumWindowNotice(window: WindowState): void {
  const min = minWindowSize(window.kind, ladderRateHidden());
  useSelectionStore
    .getState()
    .showToast(`${windowName(useLayoutStore.getState().layout.windows, window)} 창은 ${min.w}×${min.h}보다 작게 줄일 수 없습니다`);
}

export function applyArrowGeometry(
  rect: Rect,
  window: WindowState,
  others: readonly Rect[],
  area: Area,
  offset: Point,
  resize: boolean,
): { rect: Rect; guides: Guides; atMinimum: boolean } {
  if (resize) {
    const handle: ResizeHandle = offset.x ? "e" : "s";
    return resizeRect(rect, handle, offset, minWindowSize(window.kind, ladderRateHidden()), others, area);
  }
  return { ...moveRect(rect, offset, others, area), atMinimum: false };
}

export interface PointerGestureStart {
  readonly pointer: number;
  readonly point: Point;
  readonly capture: Pick<HTMLElement, "setPointerCapture" | "hasPointerCapture" | "releasePointerCapture">;
}

export interface PointerGestureHost {
  readonly doc: Pick<Document, "addEventListener" | "removeEventListener"> & {
    readonly documentElement: { readonly classList: Pick<DOMTokenList, "add" | "remove"> };
  };
  readonly win: Pick<Window, "addEventListener" | "removeEventListener">;
  watchCapture(
    target: PointerGestureStart["capture"],
    pointer: number,
    stillActive: () => boolean,
    onLost: () => void,
  ): void;
  isPointerEvent(event: Event): event is globalThis.PointerEvent;
}

const BROWSER_HOST: PointerGestureHost = {
  get doc() {
    return document;
  },
  get win() {
    return window;
  },
  watchCapture(target, pointer, stillActive, onLost) {
    watchPointerCapture(target as Element, pointer, stillActive, onLost);
  },
  isPointerEvent(event): event is globalThis.PointerEvent {
    return event instanceof globalThis.PointerEvent;
  },
};

export type ActiveGesture<Start extends PointerGestureStart> =
  | { readonly kind: "idle" }
  | { readonly kind: "pressed"; readonly start: Start }
  | { readonly kind: "dragging"; readonly start: Start; readonly point: Point; readonly shift: boolean };

export interface PointerGestureConfig<Start extends PointerGestureStart> {
  readonly className: string;
  readonly classOnPress: boolean;
  readonly shieldWhilePressed: boolean;
  readonly suppressOnCancel: boolean;
  readonly trackShift?: boolean;
  readonly exceedsThreshold: (dx: number, dy: number) => boolean;
  readonly preventUp?: (start: Start, wasDragging: boolean) => boolean;
  readonly valid: (start: Start) => boolean;
  readonly onDrag: (start: Start, point: Point, shift: boolean) => void;
  readonly onComplete: (start: Start, point: Point, shift: boolean, wasDragging: boolean, accepted: boolean) => void;
  readonly onFinish: (start: Start, reason: "complete" | "cancel") => void;
  readonly onIdleEscape?: () => void;
}

export interface PointerGestureController<Start extends PointerGestureStart> {
  attach(): () => void;
  begin(start: Start): void;
  cancel(): void;
  current(): ActiveGesture<Start>;
  lostCapture(pointerId: number): void;
}

const BLOCKED_EVENTS = ["pointerdown", "click", "dblclick", "contextmenu", "wheel"] as const;

export function createPointerGesture<Start extends PointerGestureStart>(
  readConfig: () => PointerGestureConfig<Start>,
  host: PointerGestureHost = BROWSER_HOST,
): PointerGestureController<Start> {
  let state: ActiveGesture<Start> = { kind: "idle" };
  let suppressedPointer: number | null = null;

  const finish = (reason: "complete" | "cancel") => {
    const config = readConfig();
    const previous = state;
    state = { kind: "idle" };
    host.doc.documentElement.classList.remove(config.className);
    if (previous.kind === "idle") return;
    if (previous.kind === "dragging" || (reason === "cancel" && config.suppressOnCancel)) {
      suppressedPointer = previous.start.pointer;
    }
    if (previous.start.capture.hasPointerCapture(previous.start.pointer)) {
      previous.start.capture.releasePointerCapture(previous.start.pointer);
    }
    config.onFinish(previous.start, reason);
  };

  const cancel = () => {
    if (state.kind !== "idle") finish("cancel");
  };

  return {
    attach() {
      const onMove = (raw: Event) => {
        const event = raw as globalThis.PointerEvent;
        const active = state;
        if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
        const config = readConfig();
        if (config.shieldWhilePressed) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        if (!config.valid(active.start)) {
          finish("cancel");
          return;
        }
        const dx = event.clientX - active.start.point.x;
        const dy = event.clientY - active.start.point.y;
        if (active.kind === "pressed" && !config.exceedsThreshold(dx, dy)) return;
        if (!config.shieldWhilePressed) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        const point = { x: event.clientX, y: event.clientY };
        state = { kind: "dragging", start: active.start, point, shift: event.shiftKey };
        host.doc.documentElement.classList.add(config.className);
        config.onDrag(active.start, point, event.shiftKey);
      };

      const onUp = (raw: Event) => {
        const event = raw as globalThis.PointerEvent;
        const active = state;
        if (active.kind === "idle" || active.start.pointer !== event.pointerId) return;
        const config = readConfig();
        const wasDragging = active.kind === "dragging";
        const accepted = config.valid(active.start);
        const point = { x: event.clientX, y: event.clientY };
        if (config.preventUp ? config.preventUp(active.start, wasDragging) : true) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        finish("complete");
        config.onComplete(active.start, point, event.shiftKey, wasDragging, accepted);
      };

      const onCancelPointer = (raw: Event) => {
        const event = raw as globalThis.PointerEvent;
        const active = state;
        if (active.kind !== "idle" && active.start.pointer === event.pointerId) cancel();
      };

      const onKey = (raw: Event) => {
        const event = raw as globalThis.KeyboardEvent;
        const config = readConfig();
        const active = state;
        if (active.kind === "idle") {
          if (event.type === "keydown" && event.key === "Escape" && config.onIdleEscape) {
            event.preventDefault();
            event.stopImmediatePropagation();
            config.onIdleEscape();
          }
          return;
        }
        if (config.shieldWhilePressed) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.key === "Escape") cancel();
          return;
        }
        if (!config.valid(active.start)) {
          cancel();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          cancel();
          return;
        }
        if (active.kind === "dragging") {
          if (config.trackShift && event.key === "Shift") {
            const shift = event.type === "keydown";
            state = { ...active, shift };
            config.onDrag(active.start, active.point, shift);
          }
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };

      const onShield = (event: Event) => {
        const config = readConfig();
        if (event.type === "pointerdown") {
          if (config.shieldWhilePressed) {
            if (state.kind === "idle") suppressedPointer = null;
          } else if (host.isPointerEvent(event) && event.pointerId === suppressedPointer) {
            suppressedPointer = null;
          }
        }
        const trailing =
          event.type === "click" &&
          host.isPointerEvent(event) &&
          event.pointerId === suppressedPointer &&
          event.detail > 0;
        if (trailing) suppressedPointer = null;
        const blocking = config.shieldWhilePressed ? state.kind !== "idle" : state.kind === "dragging";
        if (!blocking && !trailing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      const { doc, win } = host;
      doc.addEventListener("pointermove", onMove, { capture: true, passive: false });
      doc.addEventListener("pointerup", onUp, true);
      doc.addEventListener("pointercancel", onCancelPointer, true);
      doc.addEventListener("keydown", onKey, true);
      doc.addEventListener("keyup", onKey, true);
      for (const type of BLOCKED_EVENTS) doc.addEventListener(type, onShield, { capture: true, passive: false });
      win.addEventListener("blur", cancel);

      return () => {
        cancel();
        doc.removeEventListener("pointermove", onMove, true);
        doc.removeEventListener("pointerup", onUp, true);
        doc.removeEventListener("pointercancel", onCancelPointer, true);
        doc.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("keyup", onKey, true);
        for (const type of BLOCKED_EVENTS) doc.removeEventListener(type, onShield, true);
        win.removeEventListener("blur", cancel);
      };
    },
    begin(start) {
      const config = readConfig();
      state = { kind: "pressed", start };
      if (config.classOnPress) host.doc.documentElement.classList.add(config.className);
      start.capture.setPointerCapture(start.pointer);
      host.watchCapture(
        start.capture,
        start.pointer,
        () => state.kind !== "idle" && state.start === start,
        cancel,
      );
    },
    cancel,
    current: () => state,
    lostCapture(pointerId) {
      if (state.kind !== "idle" && state.start.pointer === pointerId) cancel();
    },
  };
}

export function usePointerGesture<Start extends PointerGestureStart>(
  config: PointerGestureConfig<Start>,
): PointerGestureController<Start> {
  const configRef = useRef(config);
  configRef.current = config;
  const controllerRef = useRef<PointerGestureController<Start> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPointerGesture(() => configRef.current);
  }
  useEffect(() => controllerRef.current!.attach(), []);
  return controllerRef.current;
}
