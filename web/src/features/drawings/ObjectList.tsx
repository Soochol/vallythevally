import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { inScope } from "../../chart/drawings/frame";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { toolOf } from "../../chart/drawings/tools";
import { useDrawingSession } from "../../stores/drawingSession";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { ToolIcon } from "./DrawingToolbar";

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
    {!drawings.length && <div className="draw-empty"><ToolIcon path="M4 20 L20 4 M4 4 H9 M4 4 V9 M20 20 H15 M20 20 V15" /><p>차트에 생각을 그려 보세요</p><span>T 추세선 · H 수평선</span></div>}
    <div className="draw-object-rows">{drawings.map((d) => {
      const tool = toolOf(d.tool); const name = d.text?.slice(0, 20) || tool?.label || d.tool;
      return <div className="draw-object-row" key={d.id} data-drawing-id={d.id} data-selected={selected.includes(d.id)} data-hidden={d.hidden}
        draggable onDragStart={(e) => { setDragged(d.id); e.dataTransfer.setData("text/plain", d.id); }} onDragEnd={() => setDragged(null)}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); if (dragged && dragged !== d.id) surfaceFor(slot)?.reorder(dragged, "front", d.id, e.clientY < rect.top + rect.height / 2 ? "above" : "below"); setDragged(null); }}>
        <button className="draw-object-name" aria-label={`고르기: ${name}`} aria-pressed={selected.includes(d.id)} disabled={d.hidden} onClick={(e) => { useDrawingSession.getState().select([d.id], e.ctrlKey || e.metaKey); surfaceFor(slot)?.reveal(d.id); }}>
          <ToolIcon path={tool?.icon ?? "M4 12 H20"} /><span>{name}</span></button>
        <button className="icon-btn" aria-label={`${name} ${d.hidden ? "보이기" : "숨기기"}`} title={d.hidden ? "보이기" : "숨기기"} onClick={() => update(d.id, "hidden")}><ToolIcon path={d.hidden ? "M3 3 L21 21 M2 12 Q12 -2 22 12 Q12 26 2 12" : "M2 12 Q12 -2 22 12 Q12 26 2 12 M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12"} /></button>
        <button className="icon-btn" aria-label={`${name} ${d.locked ? "잠금 풀기" : "잠그기"}`} title={d.locked ? "잠금 풀기" : "잠그기"} onClick={() => update(d.id, "locked")}><ToolIcon path={d.locked ? "M7 10 V7 A5 5 0 0 1 17 7 V10 M5 10 H19 V21 H5 Z" : "M7 10 V7 A5 5 0 0 1 17 7 M5 10 H19 V21 H5 Z"} /></button>
        <button className="icon-btn" aria-label={`${name} 지우기`} title="지우기" onClick={() => { useDrawingSession.getState().select([d.id]); surfaceFor(slot)?.remove(true); }}>×</button>
      </div>;
    })}</div>
    <p className="draw-objects-foot">Ctrl+클릭으로 여러 개 선택 · 끌어서 순서 변경</p>
  </section>;
}

export function WatchObjectTabs() {
  const panel = useDrawingSession((s) => s.panel);
  return <div className="draw-panel-tabs" role="tablist" aria-label="오른쪽 패널"><button role="tab" aria-selected={panel === "watch"} onClick={() => useDrawingSession.setState({ panel: "watch" })}>관심종목</button><button role="tab" aria-selected={panel === "objects"} onClick={() => useDrawingSession.setState({ panel: "objects" })}>개체</button></div>;
}
