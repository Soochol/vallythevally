import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { type RowRange, visibleRowRange } from "../order/priceRange";

export const ROW_HEIGHT_PX = 24;
const OVERSCAN_ROWS = 12;
const FIRST_PAINT_HEIGHT_PX = 600;

interface Viewport {
  readonly top: number;
  readonly height: number;
}

export interface WindowedRows {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly list: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  readonly range: RowRange;
  readonly spacing: { readonly paddingTop: number; readonly paddingBottom: number };
}

export function useWindowedRows(rowCount: number): WindowedRows {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: FIRST_PAINT_HEIGHT_PX });

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const listTop = list.current ? list.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop : 0;
    const top = Math.floor(Math.max(0, element.scrollTop - listTop) / ROW_HEIGHT_PX) * ROW_HEIGHT_PX;
    const height = element.clientHeight;
    setViewport((previous) => (previous.top === top && previous.height === height ? previous : { top, height }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const range = visibleRowRange(viewport.top, viewport.height, rowCount, ROW_HEIGHT_PX, OVERSCAN_ROWS);
  return { scroller, list, onScroll: measure, range, spacing: { paddingTop: range.start * ROW_HEIGHT_PX, paddingBottom: (rowCount - range.end) * ROW_HEIGHT_PX } };
}
