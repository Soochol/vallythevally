import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { inScope } from "../../chart/drawings/frame";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { toolOf } from "../../chart/drawings/tools";
import { useDrawingSession } from "../../stores/drawingSession";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Icon, EyeIcon, DRAWING_ICONS } from "../icons";

export function ObjectList() {
  const slot = useSelectionStore((s) => s.activeSlot); const cell = useCell(slot);
  const layoutId = useLayoutStore((s) => s.layout.id); const selected = useDrawingSession((s) => s.selected);
  const sync = drawingSync(useQueryClient()); useDrawingVersion(sync);
  const [dragged, setDragged] = useState<string | null>(null);
  const all = sync.drawings(cell.symbol);
  const drawings = all.filter((d) => inScope(d.scope, layoutId, slot)).reverse();
  const elsewhere = all.length - drawings.length;
  const update = (id: string, field: "hidden" | "locked") => {
    const before = drawings.find((d) => d.id === id); if (before) sync.commit(slot, [{ kind: "update", before, after: { ...before, [field]: !before[field] } }]);
    if (field === "hidden" && before && !before.hidden) useDrawingSession.getState().select(selected.filter((item) => item !== id));
  };
  return <section className="drawing-objects" aria-label="개체 목록">
    <div className="draw-objects-head"><span>드로잉 <b>{drawings.length}</b></span><span>{elsewhere > 0 ? `다른 칸에 ${elsewhere}개` : ""}</span></div>
    {sync.loadError(cell.symbol) && <p role="alert" className="p-3 text-s text-accent">{sync.loadError(cell.symbol)} <button className="tb-btn" onClick={() => void sync.load(cell.symbol)}>다시 시도</button></p>}
    {!drawings.length && <div className="draw-empty"><Icon path={DRAWING_ICONS.empty} /><p>차트에 생각을 그려 보세요</p><span>T 추세선 · H 수평선</span></div>}
    <div className="draw-object-rows">{drawings.map((d) => {
      const tool = toolOf(d.tool); const name = d.text?.slice(0, 20) || tool?.label || d.tool;
      return <div className="draw-object-row" key={d.id} data-drawing-id={d.id} data-selected={selected.includes(d.id)} data-hidden={d.hidden}
        draggable onDragStart={(e) => { setDragged(d.id); e.dataTransfer.setData("text/plain", d.id); }} onDragEnd={() => setDragged(null)}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); if (dragged && dragged !== d.id) surfaceFor(slot)?.reorder(dragged, "front", d.id, e.clientY < rect.top + rect.height / 2 ? "above" : "below"); setDragged(null); }}>
        <button className="draw-object-name" aria-label={`고르기: ${name}`} aria-pressed={selected.includes(d.id)} disabled={d.hidden} onClick={(e) => { useDrawingSession.getState().select([d.id], e.ctrlKey || e.metaKey); surfaceFor(slot)?.reveal(d.id); }}>
          <Icon path={tool?.icon ?? DRAWING_ICONS.hline} /><span>{name}</span></button>
        <button className="icon-btn" aria-label={`${name} ${d.hidden ? "보이기" : "숨기기"}`} title={d.hidden ? "보이기" : "숨기기"} onClick={() => update(d.id, "hidden")}><EyeIcon off={d.hidden} /></button>
        <button className="icon-btn" aria-label={`${name} ${d.locked ? "잠금 풀기" : "잠그기"}`} title={d.locked ? "잠금 풀기" : "잠그기"} onClick={() => update(d.id, "locked")}><Icon path={d.locked ? DRAWING_ICONS.locked : DRAWING_ICONS.unlocked} /></button>
        <button className="icon-btn" aria-label={`${name} 지우기`} title="지우기" onClick={() => { useDrawingSession.getState().select([d.id]); surfaceFor(slot)?.remove(true); }}>×</button>
      </div>;
    })}</div>
    <p className="draw-objects-foot">Ctrl+클릭으로 여러 개 선택 · 끌어서 순서 변경</p>
  </section>;
}
