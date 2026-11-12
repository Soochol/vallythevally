import { useEffect, useRef, useState } from "react";
import { Popover } from "../overlay/Popover";
import { CloseIcon } from "../icons";
import type { Period } from "../../api/generated/Period";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { sameContent } from "../../chart/drawings/history";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import { PERIODS, PERIOD_LABEL } from "../../lib/symbol";
import { useDrawingSession, type DrawingEditor } from "../../stores/drawingSession";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { INPUT, StyleFields } from "./StyleFields";
import { calendarTime, parseCalendarTime, parseSeconds } from "./timeInput";

const close = (slot: number) => { useDrawingSession.setState({ editor: null }); surfaceFor(slot)?.focus(); };
function confirm(slot: number, editor: DrawingEditor) {
  const surface = surfaceFor(slot); if (!surface) return;
  const current = surface.sync.drawings(editor.original.symbol).find((d) => d.id === editor.original.id) ?? null;
  if (!sameContent(current, editor.original)) { useSelectionStore.getState().showToast("다른 곳에서 바뀐 드로잉이라 수정하지 않았습니다"); close(slot); return; }
  surface.sync.commit(slot, [{ kind: "update", before: editor.original, after: editor.draft }]);
  const ui = useUiStore.getState(); ui.setDrawingPrefs({ lastStyle: { ...ui.prefs.drawing.lastStyle, [editor.draft.tool]: editor.draft.style } });
  close(slot);
}
const draft = (patch: Partial<DrawingBody>) => useDrawingSession.setState((s) => s.editor ? { editor: { ...s.editor, draft: { ...s.editor.draft, ...patch } } } : s);
type Tab = "inputs" | "style" | "text" | "coordinates" | "visibility";
const TAB_LABEL: Record<Tab, string> = { inputs: "입력", style: "스타일", text: "글자", coordinates: "좌표", visibility: "보이기" };

export function DrawingSettings({ slot, editor }: { slot: number; editor: DrawingEditor }) {
  const tool = toolOf(editor.draft.tool); const [tab, setTab] = useState<Tab>("style");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>("button[role=tab]")?.focus(); }, []);
  if (!tool) return null;
  const tabs: Tab[] = [...(tool.settings.inputs ? ["inputs" as const] : []), "style", ...(tool.settings.text ? ["text" as const] : []), "coordinates", "visibility"];
  const fields = tab === "inputs" || tab === "style" || tab === "text" ? tool.settings[tab] ?? [] : [];
  return <Popover backdrop onClose={() => close(slot)} className="draw-modal-backdrop">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={`${tool.label} 설정`} className="draw-settings" onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(slot); }
      if (e.key === "Tab") {
        const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select, textarea")];
        const first = nodes[0]; const last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="draw-dialog-head"><h2>{tool.label}</h2><button type="button" className="icon-btn" aria-label="설정 닫기" onClick={() => close(slot)}><CloseIcon /></button></div>
      <div className="draw-settings-tabs" role="tablist" aria-label="드로잉 설정 탭">{tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}</div>
      <div role="tabpanel" aria-label={TAB_LABEL[tab]} className="draw-settings-body">
        {fields.length > 0 && <StyleFields fields={fields} style={editor.draft.style} text={editor.draft.text} change={(style) => draft({ style })} setText={(text) => draft({ text: text || null })} />}
        {tab === "coordinates" && editor.draft.points.map((p, i) => {
          const role = tool.pointRoles?.[i];
          const value = role?.uses === "price" ? null : calendarTime(p.t);
          const update = (patch: Partial<typeof p>) => draft({ points: editor.draft.points.map((point, j) => i === j ? { ...point, ...patch } : point) });
          return <fieldset className="draw-coordinate" key={i}><legend>{role?.label ?? `점 ${i + 1}`}</legend>
            {role?.uses !== "price" && (value === null
              ? <label>시각 (Unix 초)<input aria-label={`점 ${i + 1} 시각 (Unix 초)`} className={INPUT} type="text" inputMode="numeric" value={p.t} onChange={(e) => { const t = parseSeconds(e.target.value); if (t !== null) update({ t }); }} /></label>
              : <label>시각 (KST)<input aria-label={`점 ${i + 1} 시각`} className={INPUT} type="datetime-local" step={1} value={value} onChange={(e) => { const t = parseCalendarTime(e.target.value); if (t !== null) update({ t }); }} /></label>)}
            {role?.uses !== "time" && <label>가격<input aria-label={`점 ${i + 1} 가격`} className={INPUT} type="number" step="any" value={p.price} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) update({ price: e.target.valueAsNumber }); }} /></label>}
          </fieldset>;
        })}
        {tab === "visibility" && <><label className="draw-visibility-all"><input type="checkbox" checked={editor.draft.periods === null} onChange={(e) => draft({ periods: e.target.checked ? null : [...PERIODS] })} /> 모든 봉 주기</label>
          <div className="draw-periods">{PERIODS.map((p: Period) => <label key={p}><input type="checkbox" checked={editor.draft.periods === null || editor.draft.periods.includes(p)} onChange={(e) => {
            const current = editor.draft.periods ?? [...PERIODS]; const periods = e.target.checked ? [...current, p] : current.filter((v) => v !== p);
            if (periods.length) draft({ periods });
          }} />{PERIOD_LABEL[p]}</label>)}</div></>}
      </div>
      <div className="draw-settings-foot"><button className="tb-btn" type="button" onClick={() => draft({ style: tool.defaultStyle() })}>기본 스타일로</button><span />
        <button className="tb-btn" type="button" onClick={() => close(slot)}>취소</button><button className="btn-primary" type="button" onClick={() => confirm(slot, editor)}>확인</button></div>
    </div>
  </Popover>;
}

export function DrawingTextEditor({ slot, editor }: { slot: number; editor: DrawingEditor }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const surface = surfaceFor(slot); const p = editor.draft.points.at(-1); const at = p ? surface?.frame().ctx.toScreen(p) : null;
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <div ref={anchor} style={{ position: "absolute", left: Math.max(8, Math.min(at?.x ?? 80, (surface?.frame().pane.width ?? 500) - 300)), top: Math.max(8, Math.min(at?.y ?? 80, (surface?.frame().pane.height ?? 400) - 160)) }}><Popover anchor={anchor} onClose={() => close(slot)} className="draw-text-editor" style={{ width: 300 }}>
    <textarea ref={ref} className={INPUT} aria-label="드로잉 글자" rows={3} value={editor.draft.text ?? ""} onChange={(e) => draft({ text: e.target.value })} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirm(slot, editor); }
      if (e.key === "Escape") { e.preventDefault(); close(slot); }
    }} /><div><span>Enter 확인 · Shift+Enter 줄바꿈</span><button className="tb-btn" onClick={() => close(slot)}>취소</button><button className="btn-primary" onClick={() => confirm(slot, editor)}>확인</button></div>
  </Popover></div>;
}
