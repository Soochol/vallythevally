import { type RefObject, useLayoutEffect, useState } from "react";

const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);

export function useFitted<T>(ref: RefObject<HTMLElement | null>, chosen: readonly T[], fit: (chosen: readonly T[], width: number) => readonly T[]): readonly T[] {
  const [fitted, setFitted] = useState<readonly T[] | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = fit(chosen, el.clientWidth);
      setFitted((now) => (now !== null && sameItems(now, next) ? now : next));
    };
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  }, [ref, chosen, fit]);
  return fitted ?? chosen;
}
