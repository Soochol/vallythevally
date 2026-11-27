import { useEffect } from "react";
import type { WindowKind } from "../../layout/kinds";
import { symbolDropBadgeText, useSymbolDragStore, type SymbolDragPayload } from "../../stores/symbolDrag";

const CHIP_OFFSET = 14;

export function SymbolDragOverlay() {
  const payload = useSymbolDragStore((s) => s.payload);
  const outsideSource = useSymbolDragStore((s) => s.outsideSource);
  const point = useSymbolDragStore((s) => s.point);

  useEffect(() => {
    if (payload === null) return;
    const onDragOver = (event: DragEvent) => {
      const target = event.target;
      const source = payload.sourceWindow;
      const insideSource = target instanceof Element && (
        source !== null
          ? target.closest(`[data-window-id="${source}"], [data-canvas-window="${source}"]`) !== null
          : target.closest("[data-kind='watchlist']") !== null
      );
      useSymbolDragStore.getState().move({ x: event.clientX, y: event.clientY }, !insideSource);
    };
    const onFinish = () => useSymbolDragStore.getState().end();
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragend", onFinish, true);
    window.addEventListener("drop", onFinish, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragend", onFinish, true);
      window.removeEventListener("drop", onFinish, true);
    };
  }, [payload]);

  if (!payload || !outsideSource || !point) return null;
  return (
    <div
      data-symbol-drag-chip=""
      className="symbol-drag-chip"
      aria-hidden="true"
      style={{ transform: `translate(${point.x + CHIP_OFFSET}px, ${point.y + CHIP_OFFSET}px)` }}
    >
      <span className="symbol-drag-chip-name">{payload.name}</span>
      <span className="symbol-drag-chip-code">{payload.code}</span>
    </div>
  );
}

export function SymbolDropOverlay({ kind, payload }: { kind: WindowKind; payload: SymbolDragPayload }) {
  return (
    <div className="symbol-drop-overlay" aria-hidden="true">
      <div className="symbol-drop-badge" data-symbol-drop-badge="">
        {symbolDropBadgeText(kind, payload)}
      </div>
    </div>
  );
}
