import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { useDrawingSession } from "../../stores/drawingSession";
import type { Slot } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { Menu } from "../menu/Menu";
import { DashInput, WidthInput } from "./StyleFields";
import { drawingMenu } from "./menus";
import { DrawingSettings, DrawingTextEditor } from "./DrawingSettings";
import { ToolIcon } from "./DrawingToolbar";

export function DrawingOverlay({ slot }: { slot: Slot }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const session = useDrawingSession(); const sync = drawingSync(useQueryClient()); useDrawingVersion(sync);
  const root = useRef<HTMLDivElement>(null);
  const surface = surfaceFor(slot);
  if (!desktop || !surface) return null;
  const error = sync.loadError(surface.host.view()?.symbol ?? "");
  return <div ref={root} className="drawing-overlay" onPointerDown={(e) => e.stopPropagation()}>
    {error && <div className="draw-load-error" role="alert">{error}<button className="tb-btn" onClick={() => sync.refresh()}>다시 시도</button></div>}
    {session.selected.length > 0 && !session.editor && <FloatingBar slot={slot} />}
    {session.popup?.slot === slot && createPortal(<Menu label="드로잉 메뉴" root={root} items={drawingMenu(surface, session.popup.id === null)}
      className="fixed max-h-[min(600px,85vh)] overflow-y-auto text-s" style={{ left: Math.max(8, Math.min(session.popup.x, window.innerWidth - 240)), top: Math.max(8, Math.min(session.popup.y, window.innerHeight - 540)), minWidth: 220 }}
      onClose={(restore) => { useDrawingSession.setState({ popup: null }); if (restore) surface.focus(); }} />, document.body)}
    {session.editor?.kind === "settings" && <DrawingSettings slot={slot} editor={session.editor} />}
    {session.editor?.kind === "text" && <DrawingTextEditor slot={slot} editor={session.editor} />}
  </div>;
}

function FloatingBar({ slot }: { slot: number }) {
  const surface = surfaceFor(slot)!; const session = useDrawingSession();
  const selected = surface.selected(); const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 20, y: 60 });
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const follow = () => {
      const bounds = surface.selectionBounds(); const pane = surface.frame().pane;
      const w = root.current?.offsetWidth ?? 350; const h = root.current?.offsetHeight ?? 38;
      const saved = useDrawingSession.getState().toolbarAt;
      const x = Math.max(8, Math.min(saved?.x ?? (bounds ? (bounds.x1 + bounds.x2 - w) / 2 : 20), pane.width - w - 8));
      const above = bounds ? bounds.y1 - h - 14 : 60;
      const y = Math.max(8, Math.min(saved?.y ?? (above < 48 ? (bounds?.y2 ?? 60) + 14 : above), pane.height - h - 8));
      setPosition((old) => Math.abs(old.x - x) < 0.5 && Math.abs(old.y - y) < 0.5 ? old : { x, y });
      raf = requestAnimationFrame(follow);
    };
    follow(); return () => cancelAnimationFrame(raf);
  }, [surface]);
  if (!selected.length || selected.every((d) => d.hidden) || useUiStore.getState().prefs.drawing.hideAll) return null;
  const first = selected[0]!; const tool = toolOf(first.tool); if (!tool) return null;
  const common = (field: keyof typeof tool.bar) => selected.every((d) => toolOf(d.tool)?.bar[field] !== undefined);
  const change = (update: (d: DrawingBody) => DrawingBody) => {
    surface.updateSelected(update);
  };
  return <div ref={root} role="toolbar" aria-label="드로잉 스타일" className="drawing-floating" style={{ left: position.x, top: position.y }} onPointerDown={(e) => { if (e.target instanceof HTMLButtonElement) e.preventDefault(); }}>
    <button type="button" className="draw-grip" aria-label="스타일 막대 옮기기" title="끌어서 막대 옮기기" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, baseX: position.x, baseY: position.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) useDrawingSession.setState({ toolbarAt: { x: d.baseX + e.clientX - d.x, y: d.baseY + e.clientY - d.y } }); }} onPointerUp={() => { drag.current = null; }}>⠿</button>
    {common("lineColor") && tool.bar.lineColor && <input title="선 색" aria-label="선 색" type="color" value={drawingColor(tool.bar.lineColor.get(first.style)).slice(0, 7)} onChange={(e) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.lineColor?.set(d.style, e.target.value) ?? d.style }))} />}
    {common("fill") && tool.bar.fill && <input title="채움 색" aria-label="채움 색" type="color" value={drawingColor(tool.bar.fill.get(first.style).color).slice(0, 7)} onChange={(e) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), color: e.target.value }) } : d; })} />}
    {common("textColor") && tool.bar.textColor && <input title="글자 색" aria-label="글자 색" type="color" value={drawingColor(tool.bar.textColor.get(first.style)).slice(0, 7)} onChange={(e) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.textColor?.set(d.style, e.target.value) ?? d.style }))} />}
    {common("width") && tool.bar.width && <WidthInput label="선 굵기" value={tool.bar.width.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.width?.set(d.style, v) ?? d.style }))} />}
    {common("dash") && tool.bar.dash && <DashInput label="선 모양" value={tool.bar.dash.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.dash?.set(d.style, v) ?? d.style }))} />}
    <span className="draw-bar-sep" />
    <button className="icon-btn" aria-label="드로잉 설정" title="설정" onClick={() => surface.openEditor(first.id)}><ToolIcon path="M9 3 H15 L16 6 L19 7 L21 10 L19 12 L20 16 L17 19 L14 18 L12 21 L9 19 L5 19 L3 15 L5 12 L3 9 L6 6 L9 7 Z M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12" /></button>
    <button className="icon-btn" aria-label={selected.every((d) => d.locked) ? "잠금 풀기" : "잠금"} title="잠금" onClick={() => surface.updateSelected((d) => ({ ...d, locked: !selected.every((item) => item.locked) }))}><ToolIcon path={selected.every((d) => d.locked) ? "M7 10 V7 A5 5 0 0 1 17 7 V10 M5 10 H19 V21 H5 Z M12 14 V17" : "M7 10 V7 A5 5 0 0 1 17 7 M5 10 H19 V21 H5 Z"} /></button>
    <button className="icon-btn" aria-label="드로잉 지우기" title="지우기 (Delete)" onClick={() => surface.remove(true)}>×</button>
    <button className="icon-btn" aria-label="드로잉 더 보기" title="더 보기" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useDrawingSession.setState({ popup: { slot, id: first.id, x: r.left, y: r.bottom + 5 } }); }}>⋯</button>
    <span className="sr-only">{session.selected.length}개 선택됨</span>
  </div>;
}
