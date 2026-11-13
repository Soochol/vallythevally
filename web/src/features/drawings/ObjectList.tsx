import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { objectGroups, objectName, renameObject } from "../../chart/drawings/objects";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import { useDrawingSession } from "../../stores/drawingSession";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { Icon, EyeIcon, PenIcon, DRAWING_ICONS } from "../icons";
import { EmptyState, ErrorState } from "../overlay/State";
import { moveObject } from "./objectOrder";

export function ObjectList() {
  const slot = useSelectionStore((s) => s.activeSlot); const cell = useCell(slot);
  const layoutId = useLayoutStore((s) => s.layout.id); const selected = useDrawingSession((s) => s.selected);
  const prefs = useUiStore((s) => s.prefs.drawing);
  const sync = drawingSync(useQueryClient()); useDrawingVersion(sync);
  const [dragged, setDragged] = useState<string | null>(null);
  const all = sync.drawings(cell.symbol);
  const groups = objectGroups(all, layoutId, slot);
  const drawings = groups.flatMap((group) => group.drawings);
  const elsewhere = all.length - drawings.length;
  const update = (before: DrawingBody, field: "hidden" | "locked") => {
    sync.commit(slot, [{ kind: "update", before, after: { ...before, [field]: !before[field] } }]);
    if (field === "hidden" && !before.hidden) useDrawingSession.getState().select(selected.filter((id) => id !== before.id));
  };
  const error = sync.loadError(cell.symbol);
  return <section data-chart-control className="drawing-objects" aria-label="개체 목록">
    <header className="draw-objects-head"><span>{cell.symbol} 드로잉 <b>{drawings.length}</b></span><div>
      <button className="icon-btn" aria-label="모든 드로잉 숨기기" title="모든 드로잉 숨기기 (Ctrl+Alt+H)" aria-pressed={prefs.hideAll} onClick={() => useUiStore.getState().setDrawingPrefs({ hideAll: !prefs.hideAll })}><EyeIcon off={prefs.hideAll} /></button>
      <button className="icon-btn" aria-label="모든 드로잉 잠그기" title="모든 드로잉 잠그기" aria-pressed={prefs.lockAll} onClick={() => useUiStore.getState().setDrawingPrefs({ lockAll: !prefs.lockAll })}><Icon path={prefs.lockAll ? DRAWING_ICONS.lockAll : DRAWING_ICONS.unlocked} /></button>
      <button className="icon-btn" aria-label="이 종목 드로잉 모두 지우기" title="이 종목 드로잉 모두 지우기 · 잠긴 개체 제외" disabled={prefs.lockAll || !all.some((d) => !d.locked)} onClick={() => {
        const removable = all.filter((d) => !d.locked);
        if (removable.length) { sync.commitWithUndo(slot, removable.map((before) => ({ kind: "delete", before })), `드로잉 ${removable.length}개를 지웠습니다`); useDrawingSession.getState().select(selected.filter((id) => !removable.some((d) => d.id === id))); }
      }}><Icon path={DRAWING_ICONS.trash} /></button>
    </div></header>
    {elsewhere > 0 && <p className="draw-objects-elsewhere">다른 칸·레이아웃에 {elsewhere}개</p>}
    {error && <ErrorState message={error} retry={() => void sync.load(cell.symbol)} />}
    {!drawings.length && !error && <EmptyState title="차트에 생각을 그려 보세요" action="추세선 그리기" onAction={() => { useDrawingSession.getState().setTool("trendline"); surfaceFor(slot)?.focus(); }}><span>T 추세선 · H 수평선 · R 사각형 · F 피보나치 · X 글자</span></EmptyState>}
    <div className="draw-object-rows">{groups.map((group) => <section key={group.kind} aria-label={group.label}>
      <h3 className="draw-object-group">{group.label} <span>{group.drawings.length}</span></h3>
      {group.drawings.map((d) => <ObjectRow key={d.id} drawing={d} selected={selected.includes(d.id)} update={(field) => update(d, field)}
        rename={(name) => { const before = sync.drawings(cell.symbol).find((item) => item.id === d.id); if (before) sync.commit(slot, [{ kind: "update", before, after: renameObject(before, name) }]); }}
        select={(toggle) => { useDrawingSession.getState().select([d.id], toggle); surfaceFor(slot)?.reveal(d.id); }}
        remove={() => { sync.commitWithUndo(slot, [{ kind: "delete", before: d }], "드로잉을 지웠습니다"); useDrawingSession.getState().select(selected.filter((id) => id !== d.id)); }}
        dragStart={() => setDragged(d.id)} dragEnd={() => setDragged(null)}
        drop={(above) => { if (dragged && dragged !== d.id) surfaceFor(slot)?.reorder(dragged, "front", d.id, above ? "above" : "below"); setDragged(null); }}
        move={(direction) => moveObject(group.drawings, d.id, direction, surfaceFor(slot))} />)}
    </section>)}</div>
    <p className="draw-objects-foot">Ctrl+클릭으로 여러 개 선택 · 끌어서 순서 변경 · F2 이름 바꾸기 · Alt+↑↓ 순서</p>
  </section>;
}

function ObjectRow({ drawing: d, selected, update, rename, select, remove, dragStart, dragEnd, drop, move }: {
  drawing: DrawingBody; selected: boolean; update(field: "hidden" | "locked"): void; rename(name: string): void; select(toggle: boolean): void; remove(): void;
  dragStart(): void; dragEnd(): void; drop(above: boolean): void; move(direction: "forward" | "backward"): void;
}) {
  const [editing, setEditing] = useState(false); const [name, setName] = useState("");
  const label = objectName(d); const tool = toolOf(d.tool);
  const edit = () => { setName(label); setEditing(true); };
  const finish = () => { if (name.trim() && name.trim() !== label) rename(name); setEditing(false); };
  return <div className="draw-object-row" data-drawing-id={d.id} data-selected={selected} data-hidden={d.hidden} draggable={!editing}
    onDragStart={(e) => { dragStart(); e.dataTransfer.setData("text/plain", d.id); }} onDragEnd={dragEnd}
    onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); drop(e.clientY < rect.top + rect.height / 2); }}
    onKeyDown={(e) => {
      if (editing || e.nativeEvent.isComposing) return;
      if (e.key === "F2") { e.preventDefault(); edit(); }
      else if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); move(e.key === "ArrowUp" ? "forward" : "backward"); }
    }}>
    {editing ? <input autoFocus className="draw-input draw-object-rename" aria-label="개체 이름" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={finish} onKeyDown={(e) => {
      e.stopPropagation(); if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); finish(); }
      if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
    }} /> : <button className="draw-object-name" aria-label={`고르기: ${label}`} aria-pressed={selected} disabled={d.hidden} onClick={(e) => select(e.ctrlKey || e.metaKey)} onDoubleClick={edit} title="두 번 눌러 이름 바꾸기 (F2)"><Icon path={tool?.icon ?? DRAWING_ICONS.hline} /><span>{label}</span></button>}
    <button className="icon-btn" aria-label={`${label} 이름 바꾸기`} title="이름 바꾸기 (F2)" onClick={edit}><PenIcon /></button>
    <button className="icon-btn" aria-label={`${label} ${d.hidden ? "보이기" : "숨기기"}`} title={d.hidden ? "보이기" : "숨기기"} onClick={() => update("hidden")}><EyeIcon off={d.hidden} /></button>
    <button className="icon-btn" aria-label={`${label} ${d.locked ? "잠금 풀기" : "잠그기"}`} title={d.locked ? "잠금 풀기" : "잠그기"} onClick={() => update("locked")}><Icon path={d.locked ? DRAWING_ICONS.locked : DRAWING_ICONS.unlocked} /></button>
    <button className="icon-btn" aria-label={`${label} 지우기`} title="지우기" onClick={remove}><Icon path={DRAWING_ICONS.trash} /></button>
  </div>;
}
