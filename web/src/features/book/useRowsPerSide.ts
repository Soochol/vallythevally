import { type RefObject, useLayoutEffect, useState } from "react";
import { LADDER_ROWS, ROWS_ABOVE_BASE } from "../market-window/ladder";

const ROW_HEIGHT_PX = 24;
const LADDER_VERTICAL_PADDING_PX = 12;
const MIN_ROWS_PER_SIDE = 2;

export function rowsPerSideFor(heightPx: number, rowHeightPx = ROW_HEIGHT_PX): number {
  if (!(heightPx > 0) || !(rowHeightPx > 0)) return ROWS_ABOVE_BASE;
  const fitting = Math.floor((heightPx - LADDER_VERTICAL_PADDING_PX) / (2 * rowHeightPx));
  return Math.min(ROWS_ABOVE_BASE, Math.max(MIN_ROWS_PER_SIDE, fitting));
}

export function visibleLadderRows<T>(rows: readonly T[], rowsPerSide: number): readonly T[] {
  return rowsPerSide >= ROWS_ABOVE_BASE ? rows : rows.slice(ROWS_ABOVE_BASE - rowsPerSide, ROWS_ABOVE_BASE + rowsPerSide);
}

export function useRowsPerSide(ladder: RefObject<HTMLElement | null>, rowHeightPx = ROW_HEIGHT_PX): number {
  const [rowsPerSide, setRowsPerSide] = useState(LADDER_ROWS / 2);
  useLayoutEffect(() => {
    const node = ladder.current;
    if (!node) return;
    setRowsPerSide(rowsPerSideFor(node.clientHeight, rowHeightPx));
    const observer = new ResizeObserver(([entry]) => setRowsPerSide(rowsPerSideFor(entry!.contentRect.height, rowHeightPx)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ladder, rowHeightPx]);
  return rowsPerSide;
}
