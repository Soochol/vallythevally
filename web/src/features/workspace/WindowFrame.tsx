import { type HTMLAttributes, type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type { ResizeHandle } from "../../layout/canvas/snap";
import type { WindowId } from "../../layout/kinds";
import type { Rect } from "../../layout/placement";
import { useLayoutStore } from "../../stores/layout";
import { applySymbolDrop, hasDraggedSymbol, isSymbolDropKind, readDraggedSymbol, useSymbolDragStore } from "../../stores/symbolDrag";
import { SymbolDropOverlay } from "./SymbolDragOverlay";

export type FrameBindings = {
  activate(event: globalThis.PointerEvent): void;
  header: Pick<HTMLAttributes<HTMLDivElement>, "onPointerDown" | "onDoubleClick" | "onKeyDown" | "onLostPointerCapture" | "onFocus">;
  resize(handle: ResizeHandle): HTMLAttributes<HTMLDivElement>["onPointerDown"];
};

const HANDLES: readonly ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function WindowFrame({ id, name, rect, layer, panelId, overflow, header, bindings, maximized, active, front = false, surface = "canvas" }: {
  surface?: "canvas" | "dock-float";
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
  front?: boolean;
}) {
  const frame = useRef<HTMLElement>(null);
  const activate = useEffectEvent((event: globalThis.PointerEvent) => bindings.activate(event));
  const kind = useLayoutStore((s) => s.layout.windows.find((w) => w.id === id)?.kind ?? null);
  const dragPayload = useSymbolDragStore((s) => s.payload);
  const dragTarget = useSymbolDragStore((s) => s.target);
  const canDrop = kind !== null && isSymbolDropKind(kind);
  const dropActive = canDrop && dragPayload !== null && dragTarget?.surface === "panel" && dragTarget.windowId === id;
  useLayoutEffect(() => {
    const element = frame.current!;
    element.addEventListener("pointerdown", activate, true);
    return () => element.removeEventListener("pointerdown", activate, true);
  }, []);
  useEffect(() => {
    const el = frame.current;
    if (!el || !canDrop || !kind) return;
    const onDragOver = (event: DragEvent) => {
      if (!hasDraggedSymbol(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      useSymbolDragStore.getState().setTarget({ windowId: id, kind, surface: "panel" });
    };
    const onDragLeave = (event: DragEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) {
        const current = useSymbolDragStore.getState().target;
        if (current?.windowId === id && current.surface === "panel") useSymbolDragStore.getState().setTarget(null);
      }
    };
    const onDrop = (event: DragEvent) => {
      const payload = readDraggedSymbol(event.dataTransfer);
      if (!payload) return;
      event.preventDefault();
      applySymbolDrop(id, kind, payload, "panel");
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [id, kind, canDrop]);
  return (
    <section ref={frame} data-canvas-window={surface === "canvas" ? id : undefined} data-dock-float={surface === "dock-float" ? id : undefined} data-kind={kind ?? undefined} data-active-cell={active ? "" : undefined} data-front={front ? "" : undefined} data-maximized={maximized ? "" : undefined} data-chart-escape-owner={maximized ? "" : undefined} data-symbol-drop-active={dropActive ? "" : undefined} aria-label={`${name} 창`} className="window-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: layer }}>
      <div tabIndex={0} role="group" aria-label={`${name} 창 머리`} data-window-header={id} data-chart-control="" className="window-head" {...bindings.header}>{header}</div>
      <div id={panelId} className={`window-panel overflow-${overflow}`} />
      {dropActive && dragPayload && kind && <SymbolDropOverlay kind={kind} payload={dragPayload} />}
      {!maximized && HANDLES.map((handle) => <div key={handle} data-chart-control="" data-resize-handle={handle} aria-label={`${name} 창 크기 ${handle}`} className={`window-resize window-resize-${handle}`} onPointerDown={bindings.resize(handle)} onLostPointerCapture={bindings.header.onLostPointerCapture} />)}
    </section>
  );
}
