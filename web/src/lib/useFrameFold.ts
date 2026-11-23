import { useCallback, useEffect, useRef, useState } from "react";

export function useFrameFold<S>(initial: () => S): readonly [S, (change: (state: S) => S) => void] {
  const [shown, setShown] = useState(initial);
  const latest = useRef(shown);
  const pendingFrame = useRef<number | null>(null);
  const fold = useCallback((change: (state: S) => S) => {
    latest.current = change(latest.current);
    if (pendingFrame.current !== null) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      setShown(latest.current);
    });
  }, []);
  useEffect(() => () => {
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
  }, []);
  return [shown, fold];
}
