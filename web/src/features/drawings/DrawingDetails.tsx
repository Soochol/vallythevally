import { type PointerEvent, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "../overlay/Popover";
import { belowTopbar } from "../overlay/position";
import { panelDomId, tabDomId, Tabs } from "../ui/Tabs";
import { CloseIcon, DRAWING_ICONS, Icon } from "../icons";
import type { Period } from "../../api/generated/Period";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { defaultObjectStyle, reusableStyle } from "../../chart/drawings/objects";
import { sameContent } from "../../chart/drawings/history";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import { isMinutePeriod, PERIODS, PERIOD_LABEL } from "../../lib/symbol";
import { useDrawingSession, type DrawingEditor } from "../../stores/drawingSession";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { INPUT, StyleFields } from "./StyleFields";
import { applyTemplateStyle, buildTemplateFromDrawing, BUILTIN_TEMPLATES } from "./templates";
import { calendarTime, parseCalendarTime, parseSeconds } from "./timeInput";
import type { WindowId } from "../../layout/kinds";

const close = (cellId: WindowId) => { useDrawingSession.getState().patchCell(cellId, { editor: null }); surfaceFor(cellId)?.focus(); };
function confirm(cellId: WindowId, editor: DrawingEditor) {
  const surface = surfaceFor(cellId); if (!surface) return;
  const current = surface.sync.drawings(editor.original.symbol).find((d) => d.id === editor.original.id) ?? null;
  if (!sameContent(current, editor.original)) { useSelectionStore.getState().showToast("다른 곳에서 바뀐 드로잉이라 수정하지 않았습니다"); close(cellId); return; }
  surface.sync.commit(cellId, [{ kind: "update", before: editor.original, after: editor.draft }]);
  const ui = useUiStore.getState(); ui.setDrawingPrefs({ lastStyle: { ...ui.prefs.drawing.lastStyle, [editor.draft.tool]: reusableStyle(editor.draft.style) } });
  close(cellId);
}
const draft = (cellId: WindowId, patch: Partial<DrawingBody>) => useDrawingSession.getState().updateEditor(cellId, (editor) => ({ ...editor, draft: { ...editor.draft, ...patch } }));
const meaningful = (text: string | null) => text?.trim() ? text : null;
function settlePoint(cellId: WindowId, index: number) {
  const ctx = surfaceFor(cellId)?.toolContext();
  useDrawingSession.getState().updateEditor(cellId, (editor) => {
    const typed = editor.draft.points[index]; const before = editor.original.points[index];
    const setPoint = toolOf(editor.draft.tool)?.setPoint;
    if (!typed || !before || !setPoint || !ctx) return editor;
    const points = editor.draft.points.map((p, i) => i === index ? before : p);
    return { ...editor, draft: { ...editor.draft, points: setPoint(points, index, typed, ctx) } };
  });
}

type DetailsTab = "style" | "text" | "coordinates" | "visibility";
const SCREEN_EDGE = 8;
const TEXT_EDITOR_WIDTH = 320;
const MINUTE_PERIODS = PERIODS.filter(isMinutePeriod);
const CALENDAR_PERIODS = PERIODS.filter((p) => !isMinutePeriod(p));

function clampPosition(x: number, y: number, width: number, height: number) {
  const minY = belowTopbar();
  const maxX = Math.max(SCREEN_EDGE, window.innerWidth - width - SCREEN_EDGE);
  const maxY = Math.max(minY, window.innerHeight - height - SCREEN_EDGE);
  return {
    x: Math.round(Math.max(SCREEN_EDGE, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  };
}

function DetailsTemplateMenu({ cellId, editor }: { cellId: WindowId; editor: DrawingEditor }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const saved = useUiStore((s) => s.prefs.drawing.styleTemplates);
  const tool = toolOf(editor.draft.tool);
  const hasBarStyle = Boolean(tool && (tool.bar.lineColor || tool.bar.width || tool.bar.dash || tool.bar.fill));
  const all = [...saved, ...BUILTIN_TEMPLATES];

  const resetDefault = () => {
    draft(cellId, { style: defaultObjectStyle(editor.draft) });
    setOpen(false);
  };

  const saveAsToolDefault = () => {
    const ui = useUiStore.getState();
    ui.setDrawingPrefs({ lastStyle: { ...ui.prefs.drawing.lastStyle, [editor.draft.tool]: reusableStyle(editor.draft.style) } });
    useSelectionStore.getState().showToast("현재 스타일을 기본값으로 저장했습니다");
    setOpen(false);
  };

  const savePreset = () => {
    const label = name.trim() || `내 프리셋 ${saved.length + 1}`;
    const tpl = buildTemplateFromDrawing(editor.draft, label);
    if (!tpl) return;
    useUiStore.getState().setDrawingPrefs({ styleTemplates: [tpl, ...saved].slice(0, 20) });
    setName("");
  };

  return (
    <>
      <button ref={anchor} type="button" className="tb-btn draw-tpl-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>템플릿</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <Popover data-chart-control anchor={anchor} solid placement="top" role="dialog" aria-label="스타일 템플릿" className="draw-quick-pop" onClose={() => setOpen(false)}>
          <div className="draw-quick-head">
            <strong>템플릿</strong>
            <button type="button" className="icon-btn" aria-label="닫기" onClick={() => setOpen(false)}><CloseIcon size={13} /></button>
          </div>
          <div className="draw-tpl-actions">
            <button type="button" className="draw-tpl-apply" onClick={resetDefault}>기본 스타일로</button>
            <button type="button" className="draw-tpl-apply" onClick={saveAsToolDefault}>현재 스타일을 기본값으로 저장</button>
          </div>
          {hasBarStyle && (
            <>
              <div className="draw-tpl-list">
                {all.map((tpl) => {
                  const isUser = saved.some((s) => s.id === tpl.id);
                  return (
                    <div key={tpl.id} className="draw-tpl-row">
                      <button type="button" className="draw-tpl-apply" onClick={() => { draft(cellId, { style: applyTemplateStyle(editor.draft, tpl) }); setOpen(false); }}>
                        <span className="draw-tpl-sample" style={{ borderTopColor: drawingColor(tpl.color), borderTopWidth: tpl.width, borderTopStyle: tpl.dash }} />
                        <span>{tpl.name}</span>
                      </button>
                      {isUser && (
                        <button type="button" className="icon-btn" aria-label={`${tpl.name} 삭제`} onClick={() => useUiStore.getState().setDrawingPrefs({ styleTemplates: saved.filter((s) => s.id !== tpl.id) })}>
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="draw-tpl-save">
                <input type="text" className="draw-input" aria-label="새 템플릿 이름" placeholder="프리셋 이름…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); savePreset(); } }} />
                <button type="button" className="btn-primary" onClick={savePreset}>저장</button>
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

export function DrawingDetails({ cellId, editor, anchor }: { cellId: WindowId; editor: DrawingEditor; anchor: RefObject<HTMLElement | null> }) {
  const tool = toolOf(editor.draft.tool);
  const ids = useId();
  const [tab, setTab] = useState<DetailsTab>("style");
  const headRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const centerModal = useCallback(() => {
    const el = headRef.current?.closest<HTMLElement>(".draw-details");
    const width = el?.offsetWidth || 468;
    const height = el?.offsetHeight || 480;
    const minY = belowTopbar();
    const x = (window.innerWidth - width) / 2;
    const y = Math.max(minY, (window.innerHeight - height) / 2);
    setPos(clampPosition(x, y, width, height));
  }, []);

  useLayoutEffect(() => {
    centerModal();
  }, [centerModal]);

  useEffect(() => {
    const onResize = () => {
      const el = headRef.current?.closest<HTMLElement>(".draw-details");
      if (!el) return;
      setPos((prev) => {
        if (!prev) return prev;
        return clampPosition(prev.x, prev.y, el.offsetWidth || 468, el.offsetHeight || 480);
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!tool) return null;

  const surface = surfaceFor(cellId);
  const currentPeriod = surface?.host.view()?.period ?? "D";
  const ctx = surface?.frame().ctx ?? null;

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
    const el = headRef.current?.closest<HTMLElement>(".draw-details");
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: rect.left, by: rect.top };
    setDragging(true);
  };

  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const el = headRef.current?.closest<HTMLElement>(".draw-details");
    const width = el?.offsetWidth || 468;
    const height = el?.offsetHeight || 480;
    setPos(clampPosition(d.bx + (e.clientX - d.sx), d.by + (e.clientY - d.sy), width, height));
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
  };

  const fields = (kind: "inputs" | "style" | "text") => (
    <StyleFields
      fields={tool.settings[kind] ?? []}
      style={editor.draft.style}
      text={editor.draft.text}
      change={(style) => draft(cellId, { style })}
      setText={(text) => draft(cellId, { text: text || null })}
    />
  );

  const tabs: { id: DetailsTab; label: string }[] = [
    { id: "style", label: "스타일" },
    ...(tool.settings.text ? [{ id: "text" as const, label: "글자" }] : []),
    { id: "coordinates", label: "좌표" },
    { id: "visibility", label: "보이기" },
  ];

  const panel = (id: DetailsTab, children: React.ReactNode) => (
    <div role="tabpanel" id={panelDomId(ids, id)} aria-labelledby={tabDomId(ids, id)} hidden={tab !== id} className="draw-panel">{children}</div>
  );

  const p0 = editor.draft.points[0];
  const pLast = editor.draft.points.length >= 2 ? editor.draft.points[1] : undefined;
  const priceDiff = p0 && pLast ? pLast.price - p0.price : null;
  const pricePct = p0 && priceDiff !== null && p0.price > 0 ? (priceDiff / p0.price) * 100 : null;
  const barsSpan = p0 && pLast && ctx ? ctx.barsBetween(p0.t, pLast.t) : null;

  const isPeriodChecked = (p: Period) => editor.draft.periods === null || editor.draft.periods.includes(p);
  const togglePeriod = (p: Period, checked: boolean) => {
    const current = editor.draft.periods ?? [...PERIODS];
    const next = checked ? [...new Set([...current, p])] : current.filter((v) => v !== p);
    if (next.length === PERIODS.length) draft(cellId, { periods: null });
    else if (next.length > 0) draft(cellId, { periods: next });
  };

  return (
    <Popover
      data-chart-control
      anchor={anchor}
      anchorRect={() => undefined}
      solid
      onClose={() => close(cellId)}
      className="draw-details"
      data-dragging={dragging ? "true" : undefined}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="dialog"
      aria-label={`${tool.label} 세부 설정`}
    >
      <div
        ref={headRef}
        className="draw-dialog-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="draw-dialog-grip" aria-hidden="true"><Icon path={DRAWING_ICONS.grip} size={14} /></span>
        <span className="draw-dialog-icon" aria-hidden="true"><Icon path={tool.icon} size={15} /></span>
        <div className="draw-dialog-title">
          <strong>{tool.label}</strong>
          <span className="draw-dialog-sub">실시간 반영 · 드래그 이동</span>
        </div>
        <div className="draw-dialog-actions">
          <button type="button" className="icon-btn" aria-label="중앙으로 이동" title="중앙으로 이동" onClick={centerModal}>⌖</button>
          <button type="button" className="icon-btn" aria-label="세부 설정 닫기" onClick={() => close(cellId)}><CloseIcon /></button>
        </div>
      </div>
      <Tabs label="세부 설정 묶음" idPrefix={ids} items={tabs} value={tab} onChange={(id) => setTab(id as DetailsTab)} className="draw-tabs" />
      <div className="draw-details-body">
        {panel("style", <>{tool.settings.inputs && fields("inputs")}{fields("style")}</>)}
        {tool.settings.text && panel("text", fields("text"))}
        {panel("coordinates", <>
          {priceDiff !== null && (
            <div className="draw-coord-summary">
              <span>구간 요약</span>
              <strong>
                {priceDiff >= 0 ? "+" : ""}{ctx ? ctx.formatPrice(priceDiff) : priceDiff.toLocaleString()}
                {pricePct !== null ? ` (${pricePct >= 0 ? "+" : ""}${pricePct.toFixed(2)}%)` : ""}
              </strong>
              {barsSpan !== null && <span className="draw-coord-bars">{barsSpan.count}봉</span>}
            </div>
          )}
          {editor.draft.points.map((p, i) => {
            const role = tool.pointRoles?.[i];
            const value = role?.uses === "price" ? null : calendarTime(p.t);
            const name = role?.label ?? `점 ${i + 1}`;
            const fieldName = (field: string) => name === field ? field : `${name} ${field}`;
            const update = (patch: Partial<typeof p>) => draft(cellId, { points: editor.draft.points.map((point, j) => i === j ? { ...point, ...patch } : point) });
            return (
              <fieldset className="draw-coordinate" key={i}>
                <legend>{name}</legend>
                <div className="draw-coordinate-grid">
                  {role?.uses !== "time" && (
                    <label>
                      <span>가격</span>
                      <input aria-label={fieldName("가격")} className={`${INPUT} draw-mono`} type="number" step="any" value={p.price} onBlur={() => settlePoint(cellId, i)} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) update({ price: e.target.valueAsNumber }); }} />
                    </label>
                  )}
                  {role?.uses !== "price" && (value === null
                    ? <label><span>시각 (Unix 초)</span><input aria-label={fieldName("시각 (Unix 초)")} className={`${INPUT} draw-mono`} type="text" inputMode="numeric" value={p.t} onBlur={() => settlePoint(cellId, i)} onChange={(e) => { const t = parseSeconds(e.target.value); if (t !== null) update({ t }); }} /></label>
                    : <label><span>시각 (KST)</span><input aria-label={fieldName("시각")} className={INPUT} type="datetime-local" step={1} value={value} onBlur={() => settlePoint(cellId, i)} onChange={(e) => { const t = parseCalendarTime(e.target.value); if (t !== null) update({ t }); }} /></label>)}
                </div>
              </fieldset>
            );
          })}
        </>)}
        {panel("visibility", <>
          <div className="draw-visibility-top">
            <label className="draw-visibility-all">
              <input type="checkbox" checked={editor.draft.periods === null} onChange={(e) => draft(cellId, { periods: e.target.checked ? null : [...PERIODS] })} />
              모든 봉 주기
            </label>
            <div className="draw-quick-chips">
              <button type="button" className="draw-chip-btn" onClick={() => draft(cellId, { periods: [...MINUTE_PERIODS] })}>분봉만</button>
              <button type="button" className="draw-chip-btn" onClick={() => draft(cellId, { periods: [...CALENDAR_PERIODS] })}>일·주·월 이상</button>
              <button type="button" className="draw-chip-btn" onClick={() => draft(cellId, { periods: [currentPeriod] })}>현재 주기({PERIOD_LABEL[currentPeriod]})만</button>
            </div>
          </div>
          <div className="draw-period-group">
            <span className="draw-period-title">분봉</span>
            <div className="draw-periods">
              {MINUTE_PERIODS.map((p: Period) => (
                <label key={p} data-checked={isPeriodChecked(p) || undefined}>
                  <input type="checkbox" checked={isPeriodChecked(p)} onChange={(e) => togglePeriod(p, e.target.checked)} />
                  {PERIOD_LABEL[p]}
                </label>
              ))}
            </div>
          </div>
          <div className="draw-period-group">
            <span className="draw-period-title">일 · 주 · 월 · 분기 · 연</span>
            <div className="draw-periods">
              {CALENDAR_PERIODS.map((p: Period) => (
                <label key={p} data-checked={isPeriodChecked(p) || undefined}>
                  <input type="checkbox" checked={isPeriodChecked(p)} onChange={(e) => togglePeriod(p, e.target.checked)} />
                  {PERIOD_LABEL[p]}
                </label>
              ))}
            </div>
          </div>
        </>)}
      </div>
      <div className="draw-settings-foot">
        <DetailsTemplateMenu cellId={cellId} editor={editor} />
        <span />
        <button className="tb-btn" type="button" onClick={() => close(cellId)}>취소</button>
        <button className="btn-primary" type="button" onClick={() => confirm(cellId, { ...editor, draft: { ...editor.draft, text: meaningful(editor.draft.text) } })}>확인</button>
      </div>
    </Popover>
  );
}

export function DrawingTextEditor({ cellId, editor }: { cellId: WindowId; editor: DrawingEditor }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const surface = surfaceFor(cellId); const p = editor.draft.points.at(-1); const at = p ? surface?.toolContext().toScreen(p) : null;
  const typed = { ...editor, draft: { ...editor.draft, text: meaningful(editor.draft.text) } };
  const submit = () => typed.draft.text === meaningful(editor.original.text) ? close(cellId) : confirm(cellId, typed);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <div data-chart-control ref={anchor} style={{ position: "absolute", left: Math.max(8, Math.min(at?.x ?? 80, (surface?.frame().pane.width ?? 500) - TEXT_EDITOR_WIDTH)), top: Math.max(8, Math.min(at?.y ?? 80, (surface?.frame().pane.height ?? 400) - 160)) }}><Popover anchor={anchor} onClose={(reason) => reason === "outside" ? submit() : close(cellId)} className="draw-text-editor">
    <textarea ref={ref} className={INPUT} aria-label="드로잉 글자" rows={3} value={editor.draft.text ?? ""} onChange={(e) => draft(cellId, { text: e.target.value })} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); close(cellId); }
    }} /><div><span>Enter 확인 · Shift+Enter 줄바꿈</span><button className="tb-btn" onClick={() => useDrawingSession.getState().patchCell(cellId, { editor: { ...typed, kind: "settings" } })}>세부 설정</button><button className="tb-btn" onClick={() => close(cellId)}>취소</button><button className="btn-primary" onClick={submit}>확인</button></div>
  </Popover></div>;
}
