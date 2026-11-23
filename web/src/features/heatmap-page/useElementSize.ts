import { type RefObject, useLayoutEffect, useState } from "react";

export interface Size {
  w: number;
  h: number;
}

export function useElementSize(target: RefObject<HTMLElement | SVGElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const node = target.current;
    if (!node) return;
    const read = () => {
      const box = node.getBoundingClientRect();
      const next = { w: Math.round(box.width), h: Math.round(box.height) };
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [target]);
  return size;
}
