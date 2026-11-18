import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { type DragOutcome, type DragTarget, judgeDrag, type PriceGroup } from "./orderRules";

export interface DragView {
  readonly group: PriceGroup;
  readonly x: number;
  readonly y: number;
  readonly target: DragTarget;
}

const MOVE_THRESHOLD_PX = 4;

function targetAt(ladder: HTMLElement, x: number, y: number): DragTarget {
  const box = ladder.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return { kind: "outside" };
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-order-cell]");
  if (!cell || cell.dataset.price === undefined) return { kind: "ladder" };
  return { kind: "cell", side: cell.dataset.side as OrderSide, price: Number(cell.dataset.price) };
}

export function useChipDrag(ladder: RefObject<HTMLElement | null>, onDrop: (group: PriceGroup, outcome: DragOutcome) => void) {
  const [view, setView] = useState<DragView | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const drop = useRef(onDrop);
  useEffect(() => { drop.current = onDrop; });
  useEffect(() => () => stop.current?.(), []);

  const begin = useCallback((group: PriceGroup, event: React.PointerEvent) => {
    if (event.button !== 0 || !ladder.current) return;
    stop.current?.();
    const area = ladder.current;
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    let target: DragTarget = { kind: "ladder" };
    const finish = (escaped: boolean) => {
      stop.current?.();
      stop.current = null;
      setView(null);
      if (moved) drop.current(group, judgeDrag({ chipSide: group.side, chipPrice: group.price, target, escaped }));
    };
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < MOVE_THRESHOLD_PX) return;
      moved = true;
      target = targetAt(area, e.clientX, e.clientY);
      setView({ group, x: e.clientX, y: e.clientY, target });
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
