import type { HTMLAttributes, ReactNode } from "react";
import type { ResizeHandle } from "../../layout/canvas/snap";
import type { WindowId } from "../../layout/kinds";
import type { Rect } from "../../layout/placement";

export type FrameBindings = {
  activate: HTMLAttributes<HTMLDivElement>["onPointerDownCapture"];
  header: Pick<HTMLAttributes<HTMLDivElement>, "onPointerDown" | "onDoubleClick" | "onKeyDown" | "onLostPointerCapture">;
  resize(handle: ResizeHandle): HTMLAttributes<HTMLDivElement>["onPointerDown"];
};

const HANDLES: readonly ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function WindowFrame({ id, name, rect, layer, panelId, overflow, header, bindings, maximized, active }: {
  id: WindowId;
  name: string;
  rect: Rect;
  layer: number;
  panelId: string;
  overflow: "auto" | "hidden";
  header: ReactNode;
  bindings: FrameBindings;
  maximized: boolean;
  active: boolean;
}) {
  return (
    <section data-canvas-window={id} data-active-cell={active ? "" : undefined} data-maximized={maximized ? "" : undefined} data-chart-escape-owner={maximized ? "" : undefined} aria-label={`${name} 창`} className="window-frame" onPointerDownCapture={bindings.activate} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: layer }}>
      <div tabIndex={0} role="group" aria-label={`${name} 창 머리`} data-window-header={id} data-chart-control="" className="window-head" {...bindings.header}>{header}</div>
      <div id={panelId} className={`window-panel overflow-${overflow}`} />
      {!maximized && HANDLES.map((handle) => <div key={handle} data-chart-control="" data-resize-handle={handle} aria-label={`${name} 창 크기 ${handle}`} className={`window-resize window-resize-${handle}`} onPointerDown={bindings.resize(handle)} onLostPointerCapture={bindings.header.onLostPointerCapture} />)}
    </section>
  );
}
