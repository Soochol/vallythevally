import { type RefObject, useLayoutEffect, useState } from "react";

export function useBelowHeight(target: RefObject<HTMLElement | null>, limitPx: number): boolean {
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const node = target.current;
    if (!node) return;
    setBelow(node.clientHeight < limitPx);
    const observer = new ResizeObserver(([entry]) => setBelow(entry!.contentRect.height < limitPx));
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, limitPx]);
  return below;
}
