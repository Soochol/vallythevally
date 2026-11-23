import { type RefObject, useLayoutEffect, useState } from "react";

const isBelow = (heightPx: number, limitPx: number): boolean => heightPx > 0 && heightPx < limitPx;

export function useBelowHeight(target: RefObject<HTMLElement | null>, limitPx: number): boolean {
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const node = target.current;
    if (!node) return;
    setBelow(isBelow(node.clientHeight, limitPx));
    const observer = new ResizeObserver(([entry]) => setBelow(isBelow(entry!.contentRect.height, limitPx)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, limitPx]);
  return below;
}
