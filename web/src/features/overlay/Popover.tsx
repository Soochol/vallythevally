import { type HTMLAttributes, type RefObject, useLayoutEffect, useRef } from "react";
import { mountLayer } from "./topLayer";
import type { Placement, Rect } from "./position";
interface Props extends HTMLAttributes<HTMLDivElement> {
  isInside?(target: Node): boolean;
  anchor?: RefObject<HTMLElement | null>;
  focusTarget?: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
  anchorRect?: () => Rect | undefined;
  placement?: Placement;
  focus?: boolean;
  restoreFocus?: boolean;
  dismiss?: boolean;
  follow?: boolean;
  backdrop?: boolean;
  blockChartKeys?: boolean;
  onClose(reason: "escape" | "outside"): void;
}
export function Popover({ isInside, anchor, focusTarget, point, anchorRect, placement, focus, restoreFocus, dismiss, follow, backdrop, blockChartKeys, onClose, className = "", ...props }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose); close.current = onClose;
  const initial = useRef({ isInside, anchor, focusTarget, point, anchorRect, placement, focus, restoreFocus, dismiss, follow, backdrop, blockChartKeys });
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const config = initial.current;
    const point = config.point;
    return mountLayer(node, {
      ...config,
      trigger: config.anchor?.current,
      focusTarget: config.focusTarget?.current ?? config.anchor?.current ?? opener.current,
      anchor: config.anchorRect ?? (point ? () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }) : () => config.anchor?.current?.getBoundingClientRect()),
      onClose: (reason) => close.current(reason),
    });
  }, []);
  return <div ref={panel} popover="manual" tabIndex={-1} className={`ui-popover ${className}`} {...props} />;
}
