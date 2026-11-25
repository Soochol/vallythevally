import { Popover } from "../overlay/Popover";
import { ErrorState } from "../overlay/State";
import { Icon, DRAWING_ICONS, CopyIcon, MoreIcon } from "../icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { ColorPicker } from "../color/ColorPicker";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { layoutReceipt } from "../../persist/layoutReceipt";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useUiStore } from "../../stores/ui";
import { Menu } from "../menu/Menu";
import { DashInput, WidthInput } from "./StyleFields";
import { drawingMenu } from "./menus";
import { DrawingDetails, DrawingTextEditor } from "./DrawingDetails";
import type { WindowId } from "../../layout/kinds";


export function DrawingOverlay({ cellId }: { cellId: WindowId }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const cell = useDrawingSession((s) => cellDrawing(s, cellId)); const sync = drawingSync(useQueryClient(), layoutReceipt); useDrawingVersion(sync);
  const root = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const surface = surfaceFor(cellId);
  if (!desktop || !surface) return null;
  const error = sync.loadError(surface.host.view()?.symbol ?? "");
  return <div data-chart-control ref={root} className="drawing-overlay" onPointerDown={(e) => e.stopPropagation()}>
    {error && <div className="draw-load-error"><ErrorState message={error} retry={() => sync.refresh()} /></div>}
    {cell.selected.length > 0 && cell.editor?.kind !== "text" && <FloatingBar cellId={cellId} />}
    {cell.popup && <Menu label="드로잉 메뉴" root={root} items={drawingMenu(surface, cell.popup.id === null, cell.popup.fromChart ? { x: cell.popup.x, y: cell.popup.y } : null, more, () => setMore((open) => !open))}
      className="fixed max-h-[min(600px,85vh)] overflow-y-auto text-s" style={{ left: cell.popup.x, top: cell.popup.y, minWidth: 220 }}
      onClose={(restore) => { setMore(false); useDrawingSession.getState().patchCell(cellId, { popup: null }); if (restore) surface.focus(); }} />}
    {cell.editor?.kind === "text" && <DrawingTextEditor cellId={cellId} editor={cell.editor} />}
  </div>;
}

function FloatingBar({ cellId }: { cellId: WindowId }) {
  const surface = surfaceFor(cellId)!; const cell = useDrawingSession((s) => cellDrawing(s, cellId));
  const selected = surface.selected(); const root = useRef<HTMLDivElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const hideAll = useUiStore((s) => s.prefs.drawing.hideAll);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const size = useRef({ w: 350, h: 38 });
  const framesWithoutBounds = useRef(0);
  const lastSpot = useRef<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let raf = 0;
    let disposed = false;
    let settled = false;
    let observedToolbar: HTMLElement | null = null;
    const schedule = () => {
      if (disposed || raf !== 0) return;
      raf = requestAnimationFrame(sync);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface.host.el);
    const sync = () => {
      raf = 0;
      if (disposed) return;
      if (!root.current) {
        if (observedToolbar) {
          resizeObserver.unobserve(observedToolbar);
          observedToolbar = null;
        }
        setPosition(null); setShown(false); settled = false; framesWithoutBounds.current = 0; lastSpot.current = null;
        return;
      }
      const bounds = surface.selectionBounds(); const frame = surface.frame(); const pane = frame.pane;
      if (pane.height <= 0) return;
      root.current.style.setProperty("--floating-max", `${Math.max(0, pane.width - 16)}px`);
      const toolbar = root.current.querySelector<HTMLElement>(".drawing-floating");
      if (toolbar) {
        if (toolbar !== observedToolbar) {
          if (observedToolbar) resizeObserver.unobserve(observedToolbar);
          resizeObserver.observe(toolbar);
          observedToolbar = toolbar;
        }
        size.current = { w: toolbar.offsetWidth, h: toolbar.offsetHeight };
      }
      const { w, h } = size.current;
      const saved = cellDrawing(useDrawingSession.getState(), cellId).toolbarAt;
      if (bounds || saved) framesWithoutBounds.current = 0;
      else if (framesWithoutBounds.current++ < 2) { schedule(); return; }
      const left = Math.max(8, Math.min(saved?.x ?? (bounds ? (bounds.x1 + bounds.x2 - w) / 2 : 20), pane.width - w - 8));
      const above = bounds ? bounds.y1 - h - 14 : 60;
      const below = (bounds?.y2 ?? 60) + 14;
      const lowest = pane.height - h - 8;
      const top = 48;
      const y = saved ? Math.max(8, Math.min(saved.y, lowest))
        : Math.max(top, Math.min(Math.max(top, above < top ? below : above), lowest));
      const last = lastSpot.current; lastSpot.current = { x: left, y };
      const stable = last !== null && Math.abs(last.x - left) < 0.5 && Math.abs(last.y - y) < 0.5;
      setPosition((old) => old && Math.abs(old.x - left) < 0.5 && Math.abs(old.y - y) < 0.5 ? old : { x: left, y });
      if (stable) { settled = true; setShown(true); }
      else if (!settled) schedule();
    };
    const unsubscribeFrame = surface.onFrame(schedule);
    const unsubscribeSession = useDrawingSession.subscribe(schedule);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      unsubscribeFrame();
      unsubscribeSession();
    };
  }, [surface, cellId]);
  if (!selected.length || hideAll) return null;
  const first = selected[0]!; const tool = toolOf(first.tool); if (!tool) return null;
  const common = (field: keyof typeof tool.bar) => selected.every((d) => toolOf(d.tool)?.bar[field] !== undefined);
  const change = (update: (d: DrawingBody) => DrawingBody) => {
    surface.updateSelected(update);
  };
  return <div ref={root} style={{ position: "absolute", left: position?.x, top: position?.y, visibility: shown ? undefined : "hidden" }}>{position && <Popover anchor={root} follow solid focus={false} dismiss={false} blockChartKeys={false} restoreFocus={false} onClose={() => {}} role="toolbar" aria-label="드로잉 스타일" className="drawing-floating" onPointerDown={(e) => { if (e.target instanceof HTMLButtonElement) e.preventDefault(); }}>
    <button type="button" className="draw-grip" aria-label="스타일 막대 옮기기" title="끌어서 막대 옮기기" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, baseX: position?.x ?? 0, baseY: position?.y ?? 0 }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) useDrawingSession.getState().patchCell(cellId, { toolbarAt: { x: d.baseX + e.clientX - d.x, y: d.baseY + e.clientY - d.y } }); }} onPointerUp={() => { drag.current = null; }}><Icon path={DRAWING_ICONS.grip} /></button>
    {common("lineColor") && tool.bar.lineColor && <ColorPicker compact label="선 색" value={drawingColor(tool.bar.lineColor.get(first.style))} width={tool.bar.width?.get(first.style)} onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.lineColor?.set(d.style, color) ?? d.style }))} />}
    {common("fill") && tool.bar.fill && <ColorPicker compact label="채움 색" value={drawingColor(tool.bar.fill.get(first.style).color)} onChange={(color) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), color }) } : d; })} />}
    {common("textColor") && tool.bar.textColor && <ColorPicker compact label="글자 색" value={drawingColor(tool.bar.textColor.get(first.style))} onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.textColor?.set(d.style, color) ?? d.style }))} />}
    {common("width") && tool.bar.width && <WidthInput label="선 굵기" value={tool.bar.width.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.width?.set(d.style, v) ?? d.style }))} />}
    {common("dash") && tool.bar.dash && <DashInput label="선 모양" value={tool.bar.dash.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.dash?.set(d.style, v) ?? d.style }))} />}
    <span className="draw-bar-sep" />
    <button ref={detailsButton} className="icon-btn" aria-label="드로잉 세부 설정" title="좌표·글자·보이기 설정" aria-haspopup="dialog" aria-expanded={cell.editor?.kind === "settings"} onClick={() => { if (cell.editor) useDrawingSession.getState().patchCell(cellId, { editor: null }); else surface.openEditor(first.id); }}><Icon path={DRAWING_ICONS.settings} /></button>
    <button className="icon-btn" aria-label="드로잉 복제" title="복제" onClick={() => surface.clone()}><CopyIcon /></button>
    <button className="icon-btn" aria-label={selected.every((d) => d.locked) ? "잠금 풀기" : "잠금"} title="잠금" onClick={() => surface.updateSelected((d) => ({ ...d, locked: !selected.every((item) => item.locked) }))}><Icon path={selected.every((d) => d.locked) ? DRAWING_ICONS.lockAll : DRAWING_ICONS.unlocked} /></button>
    <button className="icon-btn" aria-label="드로잉 지우기" title="지우기 (Delete)" onClick={() => surface.remove(true)}><Icon path={DRAWING_ICONS.trash} /></button>
    <button className="icon-btn" aria-label="드로잉 더 보기" title="더 보기" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useDrawingSession.getState().patchCell(cellId, { popup: { id: first.id, x: r.left, y: r.bottom + 5 } }); }}><MoreIcon /></button>
    <span className="sr-only">{cell.selected.length}개 선택됨</span>
  </Popover>}
    {cell.editor?.kind === "settings" && <DrawingDetails cellId={cellId} editor={cell.editor} anchor={detailsButton} />}
  </div>;
}
