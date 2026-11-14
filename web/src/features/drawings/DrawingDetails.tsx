import { type RefObject, useEffect, useRef } from "react";
import { Popover } from "../overlay/Popover";
import { CloseIcon } from "../icons";
import type { Period } from "../../api/generated/Period";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { defaultObjectStyle, reusableStyle } from "../../chart/drawings/objects";
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
  const ui = useUiStore.getState(); ui.setDrawingPrefs({ lastStyle: { ...ui.prefs.drawing.lastStyle, [editor.draft.tool]: reusableStyle(editor.draft.style) } });
  close(slot);
}
const draft = (patch: Partial<DrawingBody>) => useDrawingSession.setState((s) => s.editor ? { editor: { ...s.editor, draft: { ...s.editor.draft, ...patch } } } : s);
const meaningful = (text: string | null) => text?.trim() ? text : null;
function settlePoint(slot: number, index: number) {
  const ctx = surfaceFor(slot)?.frame().ctx;
  useDrawingSession.setState((s) => {
    const editor = s.editor; const typed = editor?.draft.points[index]; const before = editor?.original.points[index];
    const setPoint = editor ? toolOf(editor.draft.tool)?.setPoint : undefined;
    if (!editor || !typed || !before || !setPoint || !ctx) return s;
    const points = editor.draft.points.map((p, i) => i === index ? before : p);
    return { editor: { ...editor, draft: { ...editor.draft, points: setPoint(points, index, typed, ctx) } } };
  });
}
export function DrawingDetails({ slot, editor, anchor }: { slot: number; editor: DrawingEditor; anchor: RefObject<HTMLElement | null> }) {
  const tool = toolOf(editor.draft.tool);
  if (!tool) return null;
  const fields = (kind: "inputs" | "style" | "text") => <StyleFields fields={tool.settings[kind] ?? []} style={editor.draft.style} text={editor.draft.text} change={(style) => draft({ style })} setText={(text) => draft({ text: text || null })} />;
  return <Popover data-chart-control anchor={anchor} follow placement="bottom" onClose={() => close(slot)} className="draw-details" role="dialog" aria-label={`${tool.label} 세부 설정`}>
      <div className="draw-dialog-head"><strong>{tool.label}</strong><button type="button" className="icon-btn" aria-label="세부 설정 닫기" onClick={() => close(slot)}><CloseIcon /></button></div>
      <div className="draw-details-body">
        {tool.settings.inputs && <details open><summary>입력</summary>{fields("inputs")}</details>}
        <details open><summary>스타일</summary>{fields("style")}</details>
        {tool.settings.text && <details><summary>글자</summary>{fields("text")}</details>}
        <details><summary>좌표</summary>
        {editor.draft.points.map((p, i) => {
          const role = tool.pointRoles?.[i];
          const value = role?.uses === "price" ? null : calendarTime(p.t);
          const name = role?.label ?? `점 ${i + 1}`;
          const fieldName = (field: string) => name === field ? field : `${name} ${field}`;
          const update = (patch: Partial<typeof p>) => draft({ points: editor.draft.points.map((point, j) => i === j ? { ...point, ...patch } : point) });
          return <fieldset className="draw-coordinate" key={i}><legend>{name}</legend>
            {role?.uses !== "price" && (value === null
              ? <label>시각 (Unix 초)<input aria-label={fieldName("시각 (Unix 초)")} className={INPUT} type="text" inputMode="numeric" value={p.t} onBlur={() => settlePoint(slot, i)} onChange={(e) => { const t = parseSeconds(e.target.value); if (t !== null) update({ t }); }} /></label>
              : <label>시각 (KST)<input aria-label={fieldName("시각")} className={INPUT} type="datetime-local" step={1} value={value} onBlur={() => settlePoint(slot, i)} onChange={(e) => { const t = parseCalendarTime(e.target.value); if (t !== null) update({ t }); }} /></label>)}
            {role?.uses !== "time" && <label>가격<input aria-label={fieldName("가격")} className={INPUT} type="number" step="any" value={p.price} onBlur={() => settlePoint(slot, i)} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) update({ price: e.target.valueAsNumber }); }} /></label>}
          </fieldset>;
        })}
        </details>
        <details><summary>보이기</summary><label className="draw-visibility-all"><input type="checkbox" checked={editor.draft.periods === null} onChange={(e) => draft({ periods: e.target.checked ? null : [...PERIODS] })} /> 모든 봉 주기</label>
          <div className="draw-periods">{PERIODS.map((p: Period) => <label key={p}><input type="checkbox" checked={editor.draft.periods === null || editor.draft.periods.includes(p)} onChange={(e) => {
            const current = editor.draft.periods ?? [...PERIODS]; const periods = e.target.checked ? [...current, p] : current.filter((v) => v !== p);
            if (periods.length) draft({ periods });
          }} />{PERIOD_LABEL[p]}</label>)}</div></details>
      </div>
      <div className="draw-settings-foot"><button className="tb-btn" type="button" onClick={() => draft({ style: defaultObjectStyle(editor.draft) })}>기본 스타일로</button><span />
        <button className="tb-btn" type="button" onClick={() => close(slot)}>취소</button><button className="btn-primary" type="button" onClick={() => confirm(slot, { ...editor, draft: { ...editor.draft, text: meaningful(editor.draft.text) } })}>확인</button></div>
  </Popover>;
}

export function DrawingTextEditor({ slot, editor }: { slot: number; editor: DrawingEditor }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const surface = surfaceFor(slot); const p = editor.draft.points.at(-1); const at = p ? surface?.frame().ctx.toScreen(p) : null;
  const typed = { ...editor, draft: { ...editor.draft, text: meaningful(editor.draft.text) } };
  const submit = () => typed.draft.text === meaningful(editor.original.text) ? close(slot) : confirm(slot, typed);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <div data-chart-control ref={anchor} style={{ position: "absolute", left: Math.max(8, Math.min(at?.x ?? 80, (surface?.frame().pane.width ?? 500) - 300)), top: Math.max(8, Math.min(at?.y ?? 80, (surface?.frame().pane.height ?? 400) - 160)) }}><Popover anchor={anchor} onClose={(reason) => reason === "outside" ? submit() : close(slot)} className="draw-text-editor" style={{ width: 300 }}>
    <textarea ref={ref} className={INPUT} aria-label="드로잉 글자" rows={3} value={editor.draft.text ?? ""} onChange={(e) => draft({ text: e.target.value })} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); close(slot); }
    }} /><div><span>Enter 확인 · Shift+Enter 줄바꿈</span><button className="tb-btn" onClick={() => useDrawingSession.setState({ editor: { ...typed, kind: "settings" } })}>세부 설정</button><button className="tb-btn" onClick={() => close(slot)}>취소</button><button className="btn-primary" onClick={submit}>확인</button></div>
  </Popover></div>;
}
