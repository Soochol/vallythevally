import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from "react";

export const DOCK_OPEN_DELAY_MS = 80;
export const DOCK_CLOSE_DELAY_MS = 400;

export const DockHold = createContext<() => () => void>(() => () => {});

export function useHoldDockOpen(active: boolean) {
  const acquire = useContext(DockHold);
  useEffect(() => (active ? acquire() : undefined), [active, acquire]);
}

interface Timers { open: ReturnType<typeof setTimeout> | null; close: ReturnType<typeof setTimeout> | null }

export function useDockExpansion(root: RefObject<HTMLElement | null>, keep: boolean, dragging: boolean) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [holds, setHolds] = useState(0);
  const over = useRef(false);
  const timers = useRef<Timers>({ open: null, close: null });
  const stop = useCallback((name: keyof Timers) => { const timer = timers.current[name]; if (timer) clearTimeout(timer); timers.current[name] = null; }, []);
  const acquire = useCallback(() => { setHolds((n) => n + 1); return () => setHolds((n) => n - 1); }, []);
  const hoverAfter = useCallback((delay: number, value: boolean) => {
    stop(value ? "open" : "close");
    timers.current[value ? "open" : "close"] = setTimeout(() => { timers.current[value ? "open" : "close"] = null; setHovered(value); }, delay);
  }, [stop]);

  useEffect(() => {
    const bar = root.current;
    if (!bar) return;
    const enter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      over.current = true; stop("close");
      if (!timers.current.open) hoverAfter(DOCK_OPEN_DELAY_MS, true);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      over.current = false; stop("open"); hoverAfter(DOCK_CLOSE_DELAY_MS, false);
    };
    const focusIn = (e: FocusEvent) => { if (e.target instanceof Element && e.target.matches(":focus-visible")) setFocused(true); };
    const focusOut = (e: FocusEvent) => { if (!(e.relatedTarget instanceof Node && bar.contains(e.relatedTarget))) setFocused(false); };
    bar.addEventListener("pointerenter", enter); bar.addEventListener("pointerleave", leave);
    bar.addEventListener("focusin", focusIn); bar.addEventListener("focusout", focusOut);
    return () => {
      bar.removeEventListener("pointerenter", enter); bar.removeEventListener("pointerleave", leave);
      bar.removeEventListener("focusin", focusIn); bar.removeEventListener("focusout", focusOut);
      stop("open"); stop("close");
    };
  }, [root, stop, hoverAfter]);

  const wasKept = useRef(keep);
  useEffect(() => {
    if (wasKept.current && !keep && !over.current) { stop("open"); stop("close"); setHovered(false); setTapped(false); }
    wasKept.current = keep;
  }, [keep, stop]);

  useEffect(() => {
    if (holds > 0) return;
    const bar = root.current;
    if (!bar || !bar.matches(":hover")) { over.current = false; hoverAfter(DOCK_CLOSE_DELAY_MS, false); }
  }, [holds, root, hoverAfter]);

  useEffect(() => {
    if (!tapped) return;
    const press = (e: PointerEvent) => { if (e.pointerType === "touch" && !(e.target instanceof Node && root.current?.contains(e.target))) setTapped(false); };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [tapped, root]);

  const expand = (pointerType: string) => {
    if (pointerType === "touch") setTapped(true);
    else { stop("open"); stop("close"); setHovered(true); }
  };
  const held = keep || dragging || holds > 0;
  return { expanded: held || hovered || focused || tapped, held, acquire, expand };
}
