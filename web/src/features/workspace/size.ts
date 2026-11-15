import { type RefObject, useLayoutEffect, useState } from "react";
import type { Size } from "../../layout/dock/geometry";

export const DOCK_GAP = 6;
export const CANVAS_DOCK_HEIGHT = 48;

export function useElementSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((now) => (now?.w === el.clientWidth && now.h === el.clientHeight ? now : { w: el.clientWidth, h: el.clientHeight }));
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
