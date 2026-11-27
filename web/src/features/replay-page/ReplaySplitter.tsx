import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useRef,
  useState,
} from "react";

interface ReplaySplitterProps {
  readonly orientation: "vertical" | "horizontal";
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly label: string;
  readonly testId: string;
  readonly onChange: (next: number) => void;
}

const KEY_STEP = 0.02;
const FINE_KEY_STEP = 0.005;

function clampRatio(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ReplaySplitter({
  orientation,
  value,
  min,
  max,
  defaultValue,
  containerRef,
  label,
  testId,
  onChange,
}: ReplaySplitterProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startPos: number;
    readonly startValue: number;
    readonly spanPx: number;
  } | null>(null);

  const isVertical = orientation === "vertical";

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const spanPx = isVertical ? rect.width : rect.height;
    if (spanPx <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startPos: isVertical ? event.clientX : event.clientY,
      startValue: value,
      spanPx,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentPos = isVertical ? event.clientX : event.clientY;
    const delta = (currentPos - drag.startPos) / drag.spanPx;
    onChange(clampRatio(drag.startValue + delta, min, max));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? FINE_KEY_STEP : KEY_STEP;
    const decKey = isVertical ? "ArrowLeft" : "ArrowUp";
    const incKey = isVertical ? "ArrowRight" : "ArrowDown";
    if (event.key === decKey) {
      event.preventDefault();
      onChange(clampRatio(value - step, min, max));
    } else if (event.key === incKey) {
      event.preventDefault();
      onChange(clampRatio(value + step, min, max));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      className="rp-splitter"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      data-orientation={orientation}
      data-dragging={dragging ? "" : undefined}
      data-testid={testId}
      title="끌어서 창 크기 조절 · 두 번 누르면 기본 비율로 복원"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
    />
  );
}
