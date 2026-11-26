import { Popover } from "../overlay/Popover";
import { ErrorState } from "../overlay/State";
import { Icon, DRAWING_ICONS, CopyIcon, MoreIcon, CloseIcon } from "../icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { ColorPicker } from "../color/ColorPicker";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { layoutReceipt } from "../../persist/layoutReceipt";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingTemplate } from "../../chart/drawings/prefs";
import type { DrawingBody, Extend } from "../../chart/drawings/types";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useUiStore } from "../../stores/ui";
import { Menu } from "../menu/Menu";
import { DashInput, WidthInput } from "./StyleFields";
import { drawingMenu } from "./menus";
import { DrawingDetails, DrawingTextEditor } from "./DrawingDetails";
import { FavoritesQuickBar } from "./FavoritesQuickBar";
import { ObjectTree } from "./ObjectTree";
import type { WindowId } from "../../layout/kinds";

const BUILTIN_TEMPLATES: readonly DrawingTemplate[] = [
  { id: "builtin-trend", name: "핵심 추세 (기본 2px 우연장)", color: "$draw", width: 2, dash: "solid", extend: "right", opacity: 1 },
  { id: "builtin-support", name: "지지선 (강조 2px 실선)", color: "$accent", width: 2, dash: "solid", extend: "both", opacity: 1 },
  { id: "builtin-resist", name: "저항선 (상승색 2px 파선)", color: "$up", width: 2, dash: "dashed", extend: "both", opacity: 1 },
  { id: "builtin-zone", name: "보조 구역 (하락색 1px 점선)", color: "$down", width: 1, dash: "dotted", extend: "none", opacity: 0.85 },
];

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
    <FavoritesQuickBar cellId={cellId} />
    <ObjectTree cellId={cellId} />
    {cell.selected.length > 0 && cell.editor?.kind !== "text" && <FloatingBar cellId={cellId} />}
    {cell.popup && <Menu label="드로잉 메뉴" root={root} items={drawingMenu(surface, cell.popup.id === null, cell.popup.fromChart ? { x: cell.popup.x, y: cell.popup.y } : null, more, () => setMore((open) => !open))}
      className="fixed max-h-[min(600px,85vh)] overflow-y-auto text-s" style={{ left: cell.popup.x, top: cell.popup.y, minWidth: 220 }}
      onClose={(restore) => { setMore(false); useDrawingSession.getState().patchCell(cellId, { popup: null }); if (restore) surface.focus(); }} />}
    {cell.editor?.kind === "text" && <DrawingTextEditor cellId={cellId} editor={cell.editor} />}
  </div>;
}

function toggleExtendSide(current: Extend, side: "left" | "right"): Extend {
  const hasLeft = current === "left" || current === "both";
  const hasRight = current === "right" || current === "both";
  const nextLeft = side === "left" ? !hasLeft : hasLeft;
  const nextRight = side === "right" ? !hasRight : hasRight;
  if (nextLeft && nextRight) return "both";
  if (nextLeft) return "left";
  if (nextRight) return "right";
  return "none";
}

function FloatingBar({ cellId }: { cellId: WindowId }) {
  const surface = surfaceFor(cellId)!; const cell = useDrawingSession((s) => cellDrawing(s, cellId));
  const selected = surface.selected(); const root = useRef<HTMLDivElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const hideAll = useUiStore((s) => s.prefs.drawing.hideAll);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const size = useRef({ w: 420, h: 38 });
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
  const extendVal = common("extend") && tool.bar.extend ? tool.bar.extend.get(first.style) : null;
  const statsVal = common("statsAlways") && tool.bar.statsAlways ? tool.bar.statsAlways.get(first.style) : null;
  const fillVal = common("fill") && tool.bar.fill ? tool.bar.fill.get(first.style) : null;
  const lineOpacityVal = common("lineOpacity") && tool.bar.lineOpacity ? tool.bar.lineOpacity.get(first.style) : undefined;
  return <div ref={root} style={{ position: "absolute", left: position?.x, top: position?.y, visibility: shown ? undefined : "hidden" }}>{position && <Popover anchor={root} follow solid focus={false} dismiss={false} blockChartKeys={false} restoreFocus={false} onClose={() => {}} role="toolbar" aria-label="드로잉 스타일" className="drawing-floating" onPointerDown={(e) => { if (e.target instanceof HTMLButtonElement) e.preventDefault(); }}>
    <button type="button" className="draw-grip" aria-label="스타일 막대 옮기기" title="끌어서 막대 옮기기" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, baseX: position?.x ?? 0, baseY: position?.y ?? 0 }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) useDrawingSession.getState().patchCell(cellId, { toolbarAt: { x: d.baseX + e.clientX - d.x, y: d.baseY + e.clientY - d.y } }); }} onPointerUp={() => { drag.current = null; }}><Icon path={DRAWING_ICONS.grip} /></button>
    {(common("lineColor") || common("width") || common("dash")) && <TemplatePicker first={first} change={change} />}
    {common("lineColor") && tool.bar.lineColor && <ColorPicker compact live label="선 색" value={drawingColor(tool.bar.lineColor.get(first.style))} width={tool.bar.width?.get(first.style)}
      opacity={lineOpacityVal === undefined ? undefined : { value: lineOpacityVal, min: 0.1, max: 1, onChange: (v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.lineOpacity?.set(d.style, v) ?? d.style })) }}
      onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.lineColor?.set(d.style, color) ?? d.style }))} />}
    {fillVal && tool.bar.fill && <ColorPicker compact live label="채움 색" value={drawingColor(fillVal.color)}
      toggle={{ label: "채움 켜기", checked: fillVal.on, onChange: (on) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), on }) } : d; }) }}
      opacity={{ value: fillVal.opacity, min: 0, max: 0.85, onChange: (opacity) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), on: opacity > 0, opacity }) } : d; }) }}
      onChange={(color) => change((d) => { const lens = toolOf(d.tool)?.bar.fill; return lens ? { ...d, style: lens.set(d.style, { ...lens.get(d.style), on: true, color }) } : d; })} />}
    {common("textColor") && tool.bar.textColor && <ColorPicker compact live label="글자 색" value={drawingColor(tool.bar.textColor.get(first.style))} onChange={(color) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.textColor?.set(d.style, color) ?? d.style }))} />}
    {common("width") && tool.bar.width && <WidthInput label="선 굵기" value={tool.bar.width.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.width?.set(d.style, v) ?? d.style }))} />}
    {common("dash") && tool.bar.dash && <DashInput label="선 모양" value={tool.bar.dash.get(first.style)} onChange={(v) => change((d) => ({ ...d, style: toolOf(d.tool)?.bar.dash?.set(d.style, v) ?? d.style }))} />}
    {extendVal !== null && <>
      <span className="draw-bar-sep" />
      <button type="button" className="icon-btn" aria-label="왼쪽 연장" title="왼쪽 연장 1클릭" aria-pressed={extendVal === "left" || extendVal === "both"} onClick={() => change((d) => { const lens = toolOf(d.tool)?.bar.extend; return lens ? { ...d, style: lens.set(d.style, toggleExtendSide(lens.get(d.style), "left")) } : d; })}><Icon path={DRAWING_ICONS.extendLeft} /></button>
      <button type="button" className="icon-btn" aria-label="오른쪽 연장" title="오른쪽 연장 1클릭" aria-pressed={extendVal === "right" || extendVal === "both"} onClick={() => change((d) => { const lens = toolOf(d.tool)?.bar.extend; return lens ? { ...d, style: lens.set(d.style, toggleExtendSide(lens.get(d.style), "right")) } : d; })}><Icon path={DRAWING_ICONS.extendRight} /></button>
    </>}
    {statsVal !== null && <button type="button" className="icon-btn draw-bar-chip" aria-label="통계 늘 보이기" title="가격차·등락률·봉수 통계 늘 보이기" aria-pressed={statsVal} onClick={() => change((d) => { const lens = toolOf(d.tool)?.bar.statsAlways; return lens ? { ...d, style: lens.set(d.style, !statsVal) } : d; })}>Δ%</button>}
    {selected.length === 1 && tool.bar.levels && <QuickFibButton first={first} change={change} />}
    {selected.length === 1 && tool.bar.riskBudget && <QuickRiskButton first={first} change={change} />}
    <span className="draw-bar-sep" />
    <ZOrderButton onReorder={(dir) => surface.reorder(first.id, dir)} />
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

function TemplatePicker({ first, change }: { first: DrawingBody; change(update: (d: DrawingBody) => DrawingBody): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const saved = useUiStore((s) => s.prefs.drawing.styleTemplates);
  const all = [...saved, ...BUILTIN_TEMPLATES];

  const applyTemplate = (tpl: DrawingTemplate) => {
    change((d) => {
      const bar = toolOf(d.tool)?.bar;
      if (!bar) return d;
      let style = d.style;
      if (bar.lineColor) style = bar.lineColor.set(style, tpl.color);
      if (bar.lineOpacity && tpl.opacity !== undefined) style = bar.lineOpacity.set(style, tpl.opacity);
      if (bar.width) style = bar.width.set(style, tpl.width);
      if (bar.dash) style = bar.dash.set(style, tpl.dash);
      if (bar.extend && tpl.extend) style = bar.extend.set(style, tpl.extend);
      if (bar.fill && tpl.fillColor) style = bar.fill.set(style, { ...bar.fill.get(style), color: tpl.fillColor, ...(tpl.fillOn === undefined ? {} : { on: tpl.fillOn }), ...(tpl.fillOpacity === undefined ? {} : { opacity: tpl.fillOpacity }) });
      return { ...d, style };
    });
    setOpen(false);
  };

  const saveCurrent = () => {
    const bar = toolOf(first.tool)?.bar;
    if (!bar) return;
    const label = name.trim() || `내 프리셋 ${saved.length + 1}`;
    const fill = bar.fill?.get(first.style);
    const tpl: DrawingTemplate = {
      id: `tpl-${Date.now()}`,
      name: label,
      color: bar.lineColor ? drawingColor(bar.lineColor.get(first.style)) : drawingColor("$draw"),
      width: bar.width ? bar.width.get(first.style) : 2,
      dash: bar.dash ? bar.dash.get(first.style) : "solid",
      ...(bar.lineOpacity ? { opacity: bar.lineOpacity.get(first.style) } : {}),
      ...(bar.extend ? { extend: bar.extend.get(first.style) } : {}),
      ...(fill ? { fillOn: fill.on, fillColor: drawingColor(fill.color), fillOpacity: fill.opacity } : {}),
    };
    useUiStore.getState().setDrawingPrefs({ styleTemplates: [tpl, ...saved].slice(0, 20) });
    setName("");
  };

  return <>
    <button ref={anchor} type="button" className="icon-btn" aria-label="스타일 템플릿" title="스타일 템플릿 저장·적용" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <Icon path={DRAWING_ICONS.presets} />
    </button>
    {open && <Popover data-chart-control anchor={anchor} solid placement="bottom" role="dialog" aria-label="스타일 템플릿" className="draw-quick-pop" onClose={() => setOpen(false)}>
      <div className="draw-quick-head"><strong>스타일 템플릿</strong><button type="button" className="icon-btn" aria-label="닫기" onClick={() => setOpen(false)}><CloseIcon size={13} /></button></div>
      <div className="draw-tpl-list">
        {all.map((tpl) => {
          const isUser = saved.some((s) => s.id === tpl.id);
          return <div key={tpl.id} className="draw-tpl-row">
            <button type="button" className="draw-tpl-apply" onClick={() => applyTemplate(tpl)}>
              <span className="draw-tpl-sample" style={{ borderTopColor: drawingColor(tpl.color), borderTopWidth: tpl.width, borderTopStyle: tpl.dash }} />
              <span>{tpl.name}</span>
            </button>
            {isUser && <button type="button" className="icon-btn" aria-label={`${tpl.name} 삭제`} onClick={() => useUiStore.getState().setDrawingPrefs({ styleTemplates: saved.filter((s) => s.id !== tpl.id) })}><CloseIcon size={12} /></button>}
          </div>;
        })}
      </div>
      <div className="draw-tpl-save">
        <input type="text" className="draw-input" aria-label="새 템플릿 이름" placeholder="현재 스타일 저장 이름…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrent(); } }} />
        <button type="button" className="btn-primary" onClick={saveCurrent}>저장</button>
      </div>
    </Popover>}
  </>;
}

function QuickFibButton({ first, change }: { first: DrawingBody; change(update: (d: DrawingBody) => DrawingBody): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const bar = toolOf(first.tool)?.bar;
  if (!bar?.levels) return null;
  const levels = bar.levels.get(first.style);
  const labels = bar.fibLabels?.get(first.style);
  const reverse = bar.fibReverse?.get(first.style) ?? false;
  return <>
    <button ref={anchor} type="button" className="icon-btn draw-bar-chip" aria-label="피보나치 수준 빠른 설정" title="레벨 체크·가격 표시·반전" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>수준</button>
    {open && <Popover data-chart-control anchor={anchor} solid placement="bottom" role="dialog" aria-label="피보나치 수준" className="draw-quick-pop" onClose={() => setOpen(false)}>
      <div className="draw-quick-head"><strong>피보나치 수준</strong><button type="button" className="icon-btn" aria-label="닫기" onClick={() => setOpen(false)}><CloseIcon size={13} /></button></div>
      <div className="draw-fib-grid">
        {levels.map((lv, idx) => (
          <label key={`${lv.value}-${idx}`} className="draw-fib-chip" data-on={lv.on || undefined}>
            <input type="checkbox" checked={lv.on} onChange={(e) => change((d) => {
              const lens = toolOf(d.tool)?.bar.levels;
              if (!lens) return d;
              const cur = lens.get(d.style);
              return { ...d, style: lens.set(d.style, cur.map((item, j) => (j === idx ? { ...item, on: e.target.checked } : item))) };
            })} />
            <i style={{ background: drawingColor(lv.color) }} />
            <span>{lv.value}</span>
          </label>
        ))}
      </div>
      {labels && bar.fibLabels && <div className="draw-quick-toggles">
        <label><input type="checkbox" checked={labels.price} onChange={(e) => change((d) => { const l = toolOf(d.tool)?.bar.fibLabels; return l ? { ...d, style: l.set(d.style, { ...l.get(d.style), price: e.target.checked }) } : d; })} /> 가격 표시</label>
        <label><input type="checkbox" checked={labels.ratio} onChange={(e) => change((d) => { const l = toolOf(d.tool)?.bar.fibLabels; return l ? { ...d, style: l.set(d.style, { ...l.get(d.style), ratio: e.target.checked }) } : d; })} /> 비율 표시</label>
        {bar.fibReverse && <label><input type="checkbox" checked={reverse} onChange={(e) => change((d) => { const l = toolOf(d.tool)?.bar.fibReverse; return l ? { ...d, style: l.set(d.style, e.target.checked) } : d; })} /> 뒤집기</label>}
      </div>}
    </Popover>}
  </>;
}

function QuickRiskButton({ first, change }: { first: DrawingBody; change(update: (d: DrawingBody) => DrawingBody): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const bar = toolOf(first.tool)?.bar;
  if (!bar?.riskBudget) return null;
  const budget = bar.riskBudget.get(first.style);
  const [entry, target, stop] = first.points;
  const riskPerShare = entry && stop ? Math.abs(entry.price - stop.price) : 0;
  const rewardPerShare = entry && target ? Math.abs(target.price - entry.price) : 0;
  const qty = budget > 0 && riskPerShare > 0 ? Math.floor(budget / riskPerShare) : 0;
  return <>
    <button ref={anchor} type="button" className="icon-btn" aria-label="리스크 수량 계산" title="허용 손실액 기반 추천 수량 계산" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <Icon path={DRAWING_ICONS.calculator} />
    </button>
    {open && <Popover data-chart-control anchor={anchor} solid placement="bottom" role="dialog" aria-label="리스크 수량 계산" className="draw-quick-pop" onClose={() => setOpen(false)}>
      <div className="draw-quick-head"><strong>리스크·수량 계산기</strong><button type="button" className="icon-btn" aria-label="닫기" onClick={() => setOpen(false)}><CloseIcon size={13} /></button></div>
      <label className="draw-risk-input">
        <span>허용 손실액 (원)</span>
        <input type="number" className="draw-input" min={0} step={100000} value={budget || ""} placeholder="예: 500000" onChange={(e) => {
          const val = Number.isFinite(e.target.valueAsNumber) ? Math.max(0, e.target.valueAsNumber) : 0;
          change((d) => { const lens = toolOf(d.tool)?.bar.riskBudget; return lens ? { ...d, style: lens.set(d.style, val) } : d; });
        }} />
      </label>
      <div className="draw-risk-summary">
        <div><span>추천 수량</span><strong>{qty.toLocaleString("ko-KR")}주</strong></div>
        <div><span>총 투입 금액</span><strong>{entry ? Math.round(qty * entry.price).toLocaleString("ko-KR") : 0}원</strong></div>
        <div><span>목표 도달 시 수익</span><strong>+{Math.round(qty * rewardPerShare).toLocaleString("ko-KR")}원</strong></div>
      </div>
    </Popover>}
  </>;
}

function ZOrderButton({ onReorder }: { onReorder(dir: "front" | "forward" | "backward" | "back"): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} className="inline-flex">
    <button type="button" className="icon-btn" aria-label="드로잉 순서" title="순서 (앞/뒤 배치)" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <Icon path={DRAWING_ICONS.layers} />
    </button>
    {open && <Menu label="드로잉 순서" root={root} placement="bottom" onClose={() => setOpen(false)} items={[
      { kind: "action", label: "맨 앞으로", onSelect: () => onReorder("front") },
      { kind: "action", label: "앞으로", onSelect: () => onReorder("forward") },
      { kind: "action", label: "뒤로", onSelect: () => onReorder("backward") },
      { kind: "action", label: "맨 뒤로", onSelect: () => onReorder("back") },
    ]} />}
  </div>;
}
