import { useLayoutEffect, useRef, useState } from "react";
import type { Size } from "../../layout/dock/geometry";
import { WINDOW_KINDS, type WindowRef } from "../../layout/kinds";
import type { DockNode } from "../../layout/placement";
import { listGroups } from "../../layout/dock/tree";

export type Point = { x: number; y: number };
export type SideSize = { name: string | null; px: number };

const POINTER_OFFSET = 16;

export function sideName(node: DockNode, windows: readonly WindowRef[]): string | null {
  if (node.kind !== "group" || listGroups(node).length !== 1) return null;
  const shown = windows.find((window) => window.id === node.active);
  return shown ? WINDOW_KINDS[shown.kind].name : null;
}

export const sharePercent = (lead: number, second: number): number => (lead + second > 0 ? Math.round((100 * lead) / (lead + second)) : 0);

export const sideLabel = ({ name, px }: SideSize): string => (name ? `${name} ${px}px` : `${px}px`);

export function speakSize({ name, px }: SideSize, percent: number): string {
  const size = `${px}픽셀, ${percent}퍼센트`;
  return name ? `${name} ${size}` : size;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(Math.max(low, high), value));

export function DockSizeBalloon({ lead, second, area, point }: { lead: SideSize; second: SideSize; area: Size; point: Point }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = element.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const percent = sharePercent(lead.px, second.px);
  const beyondRight = point.x + POINTER_OFFSET + size.w > area.w;
  const left = clamp(beyondRight ? point.x - POINTER_OFFSET - size.w : point.x + POINTER_OFFSET, 0, area.w - size.w);
  const top = clamp(point.y + POINTER_OFFSET, 0, area.h - size.h);
  return (
    <div ref={element} data-dock-balloon className="dock-balloon" aria-hidden="true" style={{ transform: `translate(${left}px, ${top}px)` }}>
      <span data-balloon-side="first" data-px={lead.px}>{sideLabel(lead)} · {percent}%</span>
      <span className="dock-balloon-bar">|</span>
      <span data-balloon-side="second" data-px={second.px}>{sideLabel(second)}</span>
    </div>
  );
}
