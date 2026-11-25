import { describe, expect, it, vi } from "vitest";
import { workArea } from "../../layout/canvas/geometry";
import { windowId } from "../../layout/kinds";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import type { WindowState } from "../../stores/layout";
import {
  applyArrowGeometry,
  createPointerGesture,
  type PointerGestureHost,
  type PointerGestureStart,
} from "./windowGesture";

interface FakeEvent {
  type: string;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  shiftKey?: boolean;
  key?: string;
  detail?: number;
  defaultPrevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function makeEvent(init: Partial<FakeEvent> & { type: string }): FakeEvent {
  const event: FakeEvent = {
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      event.stopped = true;
    },
    ...init,
  };
  return event;
}

function createFakeHost() {
  const docListeners = new Map<string, Set<EventListener>>();
  const winListeners = new Map<string, Set<EventListener>>();
  const classes = new Set<string>();
  let onLostWatch: (() => void) | null = null;

  const add = (map: Map<string, Set<EventListener>>, type: string, listener: EventListener) => {
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(listener);
  };
  const remove = (map: Map<string, Set<EventListener>>, type: string, listener: EventListener) => {
    map.get(type)?.delete(listener);
  };

  const host: PointerGestureHost = {
    doc: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        add(docListeners, type, listener as EventListener),
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        remove(docListeners, type, listener as EventListener),
      documentElement: {
        classList: {
          add: (...names: string[]) => names.forEach((n) => classes.add(n)),
          remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
        },
      },
    },
    win: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        add(winListeners, type, listener as EventListener),
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        remove(winListeners, type, listener as EventListener),
    },
    watchCapture(_target, _pointer, _stillActive, onLost) {
      onLostWatch = onLost;
    },
    isPointerEvent(event): event is globalThis.PointerEvent {
      return "pointerId" in event;
    },
  };

  const dispatchDoc = (event: FakeEvent) => {
    for (const listener of [...(docListeners.get(event.type) ?? [])]) {
      listener(event as unknown as Event);
    }
    return event;
  };

  const dispatchWin = (event: FakeEvent) => {
    for (const listener of [...(winListeners.get(event.type) ?? [])]) {
      listener(event as unknown as Event);
    }
    return event;
  };

  return { host, classes, dispatchDoc, dispatchWin, loseCapture: () => onLostWatch?.() };
}

function makeCapture() {
  const captured = new Set<number>();
  return {
    captured,
    setPointerCapture: (id: number) => {
      captured.add(id);
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
    },
  };
}

describe("createPointerGesture", () => {
  it("임계값을 넘으면 드래그를 시작하고 완료 뒤 후속 click을 한 번 막는다", () => {
    const { host, classes, dispatchDoc } = createFakeHost();
    const onDrag = vi.fn();
    const onComplete = vi.fn();
    const onFinish = vi.fn();
    const capture = makeCapture();

    const gesture = createPointerGesture<PointerGestureStart>(
      () => ({
        className: "dock-dragging",
        classOnPress: false,
        shieldWhilePressed: false,
        suppressOnCancel: false,
        trackShift: true,
        exceedsThreshold: (dx, dy) => Math.hypot(dx, dy) > 5,
        valid: () => true,
        onDrag,
        onComplete,
        onFinish,
      }),
      host,
    );
    const detach = gesture.attach();
    gesture.begin({ pointer: 7, point: { x: 100, y: 100 }, capture });

    expect(capture.captured.has(7)).toBe(true);
    expect(classes.has("dock-dragging")).toBe(false);

    dispatchDoc(makeEvent({ type: "pointermove", pointerId: 7, clientX: 103, clientY: 102, shiftKey: false }));
    expect(onDrag).not.toHaveBeenCalled();

    dispatchDoc(makeEvent({ type: "pointermove", pointerId: 7, clientX: 120, clientY: 100, shiftKey: false }));
    expect(classes.has("dock-dragging")).toBe(true);
    expect(onDrag).toHaveBeenCalledTimes(1);

    dispatchDoc(makeEvent({ type: "keydown", key: "Shift" }));
    expect(onDrag).toHaveBeenLastCalledWith(expect.anything(), { x: 120, y: 100 }, true);

    dispatchDoc(makeEvent({ type: "pointerup", pointerId: 7, clientX: 130, clientY: 100, shiftKey: true }));
    expect(classes.has("dock-dragging")).toBe(false);
    expect(capture.captured.has(7)).toBe(false);
    expect(onFinish).toHaveBeenCalledWith(expect.anything(), "complete");
    expect(onComplete).toHaveBeenCalledWith(expect.anything(), { x: 130, y: 100 }, true, true, true);

    const trailingClick = dispatchDoc(makeEvent({ type: "click", pointerId: 7, detail: 1 }));
    expect(trailingClick.defaultPrevented).toBe(true);
    expect(trailingClick.stopped).toBe(true);

    const nextClick = dispatchDoc(makeEvent({ type: "click", pointerId: 7, detail: 1 }));
    expect(nextClick.defaultPrevented).toBe(false);

    detach();
  });

  it("Escape와 window blur로 진행 중인 제스처를 취소하고 캡처를 해제한다", () => {
    const { host, classes, dispatchDoc, dispatchWin } = createFakeHost();
    const onFinish = vi.fn();
    const onIdleEscape = vi.fn();
    const capture = makeCapture();

    const gesture = createPointerGesture<PointerGestureStart>(
      () => ({
        className: "canvas-gesturing",
        classOnPress: true,
        shieldWhilePressed: true,
        suppressOnCancel: true,
        exceedsThreshold: (dx, dy) => Math.hypot(dx, dy) >= 4,
        valid: () => true,
        onDrag: vi.fn(),
        onComplete: vi.fn(),
        onFinish,
        onIdleEscape,
      }),
      host,
    );
    const detach = gesture.attach();

    dispatchDoc(makeEvent({ type: "keydown", key: "Escape" }));
    expect(onIdleEscape).toHaveBeenCalledTimes(1);

    gesture.begin({ pointer: 3, point: { x: 10, y: 10 }, capture });
    expect(classes.has("canvas-gesturing")).toBe(true);

    dispatchDoc(makeEvent({ type: "keydown", key: "Escape" }));
    expect(gesture.current().kind).toBe("idle");
    expect(classes.has("canvas-gesturing")).toBe(false);
    expect(capture.captured.has(3)).toBe(false);
    expect(onFinish).toHaveBeenCalledWith(expect.anything(), "cancel");

    gesture.begin({ pointer: 4, point: { x: 10, y: 10 }, capture });
    dispatchWin(makeEvent({ type: "blur" }));
    expect(gesture.current().kind).toBe("idle");
    expect(onFinish).toHaveBeenCalledTimes(2);

    detach();
  });
});

describe("applyArrowGeometry", () => {
  it("화살표 이동과 Shift 크기 조절을 공통 규칙으로 계산한다", () => {
    const chart: WindowState = {
      id: windowId("cell-0"),
      link: null,
      kind: "chart",
      symbol: "005930",
      period: "D",
      chartSettings: DEFAULT_CHART_SETTINGS,
    };
    const area = workArea(1200, 800)!;
    const moved = applyArrowGeometry({ x: 100, y: 100, w: 500, h: 400 }, chart, [], area, { x: 16, y: 0 }, false);
    expect(moved.rect.x).toBe(116);
    expect(moved.atMinimum).toBe(false);

    const resized = applyArrowGeometry({ x: 100, y: 100, w: 500, h: 400 }, chart, [], area, { x: 16, y: 0 }, true);
    expect(resized.rect.w).toBe(516);
  });
});
