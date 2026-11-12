import { type HTMLAttributes, type RefObject, useLayoutEffect, useRef } from "react";
import { mountLayer } from "./topLayer";
import type { Placement, Rect } from "./position";
interface Props extends HTMLAttributes<HTMLDivElement> {
  anchor?: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
  anchorRect?: () => Rect | undefined;
  placement?: Placement;
  focus?: boolean;
  restoreFocus?: boolean;
  dismiss?: boolean;
  follow?: boolean;
  onClose(): void;
}
export function Popover({ anchor, point, anchorRect, placement, focus, restoreFocus, dismiss, follow, onClose, className = "", ...props }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose); close.current = onClose;
  const initial = useRef({ anchor, point, anchorRect, placement, focus, restoreFocus, dismiss, follow });
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const config = initial.current;
    const point = config.point;
    return mountLayer(node, {
      ...config,
      trigger: config.anchor?.current ?? opener.current,
      anchor: config.anchorRect ?? (point ? () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }) : () => config.anchor?.current?.getBoundingClientRect()),
      onClose: () => close.current(),
    });
  }, []);
  return <div ref={panel} popover="manual" tabIndex={-1} className={`ui-popover ${className}`} {...props} />;
}
