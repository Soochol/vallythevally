import { Popover } from "../overlay/Popover";
import { ErrorState } from "../overlay/State";
import { Icon, DRAWING_ICONS, CopyIcon, MoreIcon } from "../icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { ColorPicker } from "../color/ColorPicker";
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
import { DrawingDetails, DrawingTextEditor } from "./DrawingDetails";


export function DrawingOverlay({ slot }: { slot: Slot }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const session = useDrawingSession(); const sync = drawingSync(useQueryClient()); useDrawingVersion(sync);
  const root = useRef<HTMLDivElement>(null);
  const surface = surfaceFor(slot);
  if (!desktop || !surface) return null;
  const error = sync.loadError(surface.host.view()?.symbol ?? "");
  return <div data-chart-control ref={root} className="drawing-overlay" onPointerDown={(e) => e.stopPropagation()}>
    {error && <div className="draw-load-error"><ErrorState message={error} retry={() => sync.refresh()} /></div>}
    {session.selected.length > 0 && session.editor?.kind !== "text" && <FloatingBar slot={slot} />}
    {session.popup?.slot === slot && <Menu label="드로잉 메뉴" root={root} items={drawingMenu(surface, session.popup.id === null, session.popup.fromChart ? { x: session.popup.x, y: session.popup.y } : null)}
      className="fixed max-h-[min(600px,85vh)] overflow-y-auto text-s" style={{ left: session.popup.x, top: session.popup.y, minWidth: 220 }}
      onClose={(restore) => { useDrawingSession.setState({ popup: null }); if (restore) surface.focus(); }} />}
    {session.editor?.kind === "text" && <DrawingTextEditor slot={slot} editor={session.editor} />}
  </div>;
}

function FloatingBar({ slot }: { slot: number }) {
  const surface = surfaceFor(slot)!; const session = useDrawingSession();
  const selected = surface.selected(); const root = useRef<HTMLDivElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x: 20, y: 60 });
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const follow = () => {
      const bounds = surface.selectionBounds(); const pane = surface.frame().pane;
      const toolbar = root.current?.querySelector<HTMLElement>(".drawing-floating");
      const w = toolbar?.offsetWidth ?? 350; const h = toolbar?.offsetHeight ?? 38;
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
  return <div ref={root} style={{ position: "absolute", left: position.x, top: position.y }}><Popover anchor={root} follow focus={false} dismiss={false} blockChartKeys={false} restoreFocus={false} onClose={() => {}} role="toolbar" aria-label="드로잉 스타일" className="drawing-floating" onPointerDown={(e) => { if (e.target instanceof HTMLButtonElement) e.preventDefault(); }}>
    <button type="button" className="draw-grip" aria-label="스타일 막대 옮기기" title="끌어서 막대 옮기기" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, baseX: position.x, baseY: position.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) useDrawingSession.setState({ toolbarAt: { x: d.baseX + e.clientX - d.x, y: d.baseY + e.clientY - d.y } }); }} onPointerUp={() => { drag.current = null; }}><Icon path={DRAWING_ICONS.grip} /></button>
    {common("lineColor") && tool.bar.lineColor && <ColorPicker compact label="선 색" value={drawingColor(tool.bar.lineColor.get(first.style))} width={tool.bar.width?.get(first.style)} onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.lineColor?.set(d.style, color) ?? d.style }))} />}
    {common("fill") && tool.bar.fill && <ColorPicker compact label="채움 색" value={drawingColor(tool.bar.fill.get(first.style).color)} onChange={(color) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), color }) } : d; })} />}
    {common("textColor") && tool.bar.textColor && <ColorPicker compact label="글자 색" value={drawingColor(tool.bar.textColor.get(first.style))} onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.textColor?.set(d.style, color) ?? d.style }))} />}
    {common("width") && tool.bar.width && <WidthInput label="선 굵기" value={tool.bar.width.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.width?.set(d.style, v) ?? d.style }))} />}
    {common("dash") && tool.bar.dash && <DashInput label="선 모양" value={tool.bar.dash.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.dash?.set(d.style, v) ?? d.style }))} />}
    <span className="draw-bar-sep" />
    <button ref={detailsButton} className="icon-btn" aria-label="드로잉 세부 설정" title="좌표·글자·보이기 설정" aria-haspopup="dialog" aria-expanded={session.editor?.kind === "settings"} onClick={() => { if (session.editor) useDrawingSession.setState({ editor: null }); else surface.openEditor(first.id); }}><Icon path={DRAWING_ICONS.settings} /></button>
    <button className="icon-btn" aria-label={selected.every((d) => d.locked) ? "잠금 풀기" : "잠금"} title="잠금" onClick={() => surface.updateSelected((d) => ({ ...d, locked: !selected.every((item) => item.locked) }))}><Icon path={selected.every((d) => d.locked) ? DRAWING_ICONS.lockAll : DRAWING_ICONS.unlocked} /></button>
    <button className="icon-btn" aria-label="드로잉 복제" title="복제" onClick={() => surface.clone()}><CopyIcon /></button>
    <button className="icon-btn" aria-label="드로잉 지우기" title="지우기 (Delete)" onClick={() => surface.remove(true)}><Icon path={DRAWING_ICONS.trash} /></button>
    <button className="icon-btn" aria-label="드로잉 더 보기" title="더 보기" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useDrawingSession.setState({ popup: { slot, id: first.id, x: r.left, y: r.bottom + 5 } }); }}><MoreIcon /></button>
    <span className="sr-only">{session.selected.length}개 선택됨</span>
  </Popover>
    {session.editor?.kind === "settings" && <DrawingDetails slot={slot} editor={session.editor} anchor={detailsButton} />}
  </div>;
}
