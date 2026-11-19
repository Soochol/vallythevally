import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { type DragOutcome, type DragSource, type DragTarget, judgeDrag } from "./orderRules";

export interface DragView {
  readonly source: DragSource;
  readonly x: number;
  readonly y: number;
  readonly target: DragTarget;
}

export interface DragStart {
  readonly source: DragSource;
  readonly origin: DOMRect | null;
  readonly onMoved?: () => void;
}

export interface OrderDrag {
  readonly view: DragView | null;
  begin(start: DragStart, event: React.PointerEvent): void;
}

const MOVE_THRESHOLD_PX = 4;

const within = (box: DOMRect, x: number, y: number): boolean => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

function targetAt(ladder: HTMLElement, origin: DOMRect | null, x: number, y: number): DragTarget {
  if (origin && within(origin, x, y)) return { kind: "origin" };
  if (!within(ladder.getBoundingClientRect(), x, y)) return { kind: "outside" };
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-order-cell]");
  if (!cell || cell.dataset.price === undefined) return { kind: "ladder" };
  return { kind: "cell", side: cell.dataset.side as OrderSide, price: Number(cell.dataset.price) };
}

function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

export function useOrderDrag(ladder: RefObject<HTMLElement | null>, onDrop: (source: DragSource, outcome: DragOutcome) => void): OrderDrag {
  const [view, setView] = useState<DragView | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const drop = useRef(onDrop);
  useEffect(() => { drop.current = onDrop; });
  useEffect(() => () => stop.current?.(), []);

  const begin = useCallback(({ source, origin, onMoved }: DragStart, event: React.PointerEvent) => {
    if (event.button !== 0 || !ladder.current) return;
    stop.current?.();
    const area = ladder.current;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    let target: DragTarget = { kind: "ladder" };
    const finish = (escaped: boolean) => {
      stop.current?.();
      stop.current = null;
      setView(null);
      if (!moved) return;
      swallowNextClick();
      drop.current(source, judgeDrag({ source, target, escaped }));
    };
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < MOVE_THRESHOLD_PX) return;
      if (!moved) onMoved?.();
      moved = true;
      target = targetAt(area, origin, e.clientX, e.clientY);
      setView({ source, x: e.clientX, y: e.clientY, target });
    };
    const onUp = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    stop.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ladder]);

  return { view, begin };
}
