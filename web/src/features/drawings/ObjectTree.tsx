import { useState } from "react";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { inScope } from "../../chart/drawings/frame";
import { toolOf } from "../../chart/drawings/tools";
import type { DrawingBody } from "../../chart/drawings/types";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { isIndexCode, isMinutePeriod } from "../../lib/symbol";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { ArrowIcon, CloseIcon, DRAWING_ICONS, Icon } from "../icons";

function drawingSwatchColor(d: DrawingBody): string {
  const tool = toolOf(d.tool);
  if (!tool) return drawingColor("$draw");
  if (tool.bar.lineColor) return drawingColor(tool.bar.lineColor.get(d.style));
  if (tool.bar.fill) return drawingColor(tool.bar.fill.get(d.style).color);
  if (tool.bar.textColor) return drawingColor(tool.bar.textColor.get(d.style));
  return drawingColor("$draw");
}

function periodSummary(d: DrawingBody): string {
  if (d.periods === null) return "모든 봉";
  if (d.periods.every(isMinutePeriod)) return "분봉";
  if (d.periods.every((p) => !isMinutePeriod(p))) return "일 이상";
  return `${d.periods.length}개 주기`;
}

export function ObjectTree({ cellId }: { cellId: WindowId }) {
  const cell = useDrawingSession((s) => cellDrawing(s, cellId));
  const layoutId = useLayoutStore((s) => s.layout.id);
  const prefs = useUiStore((s) => s.prefs.drawing);
  const [query, setQuery] = useState("");
  if (!cell.objectTreeOpen) return null;
  const surface = surfaceFor(cellId);
  const view = surface?.host.view();
  if (!surface || !view) return null;

  const isIndex = isIndexCode(view.symbol);
  const all = surface.sync.drawings(view.symbol).filter((d) => inScope(d.scope, layoutId, cellId) && (d.periods === null || d.periods.includes(view.period)));
  const ordered = [...all].sort((a, b) => b.z - a.z);
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? ordered.filter((d) => {
        const label = toolOf(d.tool)?.label ?? d.tool;
        return label.toLowerCase().includes(normalized) || (d.text ?? "").toLowerCase().includes(normalized);
      })
    : ordered;

  const setCell = (patch: Partial<typeof cell>) => useDrawingSession.getState().patchCell(cellId, patch);
  const toggleHidden = (id: string) => {
    if (prefs.hideAll) {
      useUiStore.getState().setDrawingPrefs({ hideAll: false });
      setCell({ hiddenIds: cell.hiddenIds.filter((x) => x !== id) });
      return;
    }
    const hiding = !cell.hiddenIds.includes(id);
    const nextHidden = hiding ? [...cell.hiddenIds, id] : cell.hiddenIds.filter((x) => x !== id);
    const nextSelected = hiding ? cell.selected.filter((x) => x !== id) : cell.selected;
    setCell({ hiddenIds: nextHidden, selected: nextSelected });
  };
  const unlocked = all.filter((d) => !d.locked && !prefs.lockAll);

  return (
    <aside data-chart-control aria-label="드로잉 개체 트리" className="draw-tree" onPointerDown={(e) => e.stopPropagation()}>
      <div className="draw-tree-head">
        <h3>
          <span>개체 트리</span>
          <span className="draw-tree-count">{all.length}</span>
        </h3>
        <button type="button" className="icon-btn" aria-label="개체 트리 닫기" onClick={() => setCell({ objectTreeOpen: false, hoveredId: null })}>
          <CloseIcon size={14} />
        </button>
      </div>
      <input
        type="text"
        aria-label="개체 검색"
        className="draw-tree-search"
        placeholder="드로잉 검색…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="draw-tree-list" role="list">
        {filtered.length === 0 ? (
          <p className="draw-tree-empty">{all.length === 0 ? "이 차트에 드로잉이 없습니다" : "검색 결과가 없습니다"}</p>
        ) : (
          filtered.map((d) => {
            const tool = toolOf(d.tool);
            const selected = cell.selected.includes(d.id);
            const isHidden = prefs.hideAll || cell.hiddenIds.includes(d.id);
            const firstPoint = d.points[0];
            const meta = [firstPoint ? formatPrice(firstPoint.price, isIndex) : null, periodSummary(d)].filter(Boolean).join(" · ");
            return (
              <div
                key={d.id}
                role="listitem"
                className="draw-tree-row"
                data-selected={selected || undefined}
                data-hidden={isHidden || undefined}
                onMouseEnter={() => setCell({ hoveredId: d.id })}
                onMouseLeave={() => { if (cellDrawing(useDrawingSession.getState(), cellId).hoveredId === d.id) setCell({ hoveredId: null }); }}
                onClick={() => {
                  useDrawingSession.getState().setTool(cellId, null);
                  useDrawingSession.getState().select(cellId, [d.id]);
                  surface.focus();
                }}
              >
                <span className="draw-tree-swatch" style={{ background: drawingSwatchColor(d) }} />
                {tool && <Icon path={tool.icon} size={15} className="draw-tree-icon" />}
                <span className="draw-tree-info">
                  <span className="draw-tree-name">{d.text?.trim() || tool?.label || d.tool}</span>
                  <span className="draw-tree-meta">{meta}</span>
                </span>
                <span className="draw-tree-acts" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="draw-tree-act" aria-label="앞으로 이동" title="앞으로 이동" onClick={() => surface.reorder(d.id, "forward")}>
                    <ArrowIcon size={12} dir="up" />
                  </button>
                  <button type="button" className="draw-tree-act" aria-label="뒤로 이동" title="뒤로 이동" onClick={() => surface.reorder(d.id, "backward")}>
                    <ArrowIcon size={12} dir="down" />
                  </button>
                  <button type="button" className="draw-tree-act" data-on={isHidden || undefined} aria-label={isHidden ? "보이기" : "숨기기"} title={isHidden ? "보이기" : "숨기기"} onClick={() => toggleHidden(d.id)}>
                    <Icon path={isHidden ? DRAWING_ICONS.eyeOff : DRAWING_ICONS.eye} size={13} />
                  </button>
                  <button type="button" className="draw-tree-act" data-on={d.locked || undefined} aria-label={d.locked ? "잠금 풀기" : "잠금"} title={d.locked ? "잠금 풀기" : "잠금"} onClick={() => {
                    surface.sync.commit(cellId, [{ kind: "update", before: d, after: { ...d, locked: !d.locked } }]);
                  }}>
                    <Icon path={d.locked ? DRAWING_ICONS.lockAll : DRAWING_ICONS.unlocked} size={13} />
                  </button>
                  <button type="button" className="draw-tree-act" aria-label="지우기" title="지우기" onClick={() => {
                    surface.sync.commitWithUndo(cellId, [{ kind: "delete", before: d }], "드로잉을 지웠습니다");
                    if (selected) useDrawingSession.getState().select(cellId, cell.selected.filter((x) => x !== d.id));
                  }}>
                    <Icon path={DRAWING_ICONS.trash} size={13} />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="draw-tree-foot">
        <button type="button" className="btn btn-sm" onClick={() => {
          setCell({ hiddenIds: [] });
          if (prefs.hideAll) useUiStore.getState().setDrawingPrefs({ hideAll: false });
        }}>모두 보이기</button>
        <button type="button" className="btn btn-sm text-danger" disabled={unlocked.length === 0} onClick={() => {
          if (unlocked.length === 0) return;
          surface.sync.commitWithUndo(cellId, unlocked.map((before) => ({ kind: "delete", before })), `드로잉 ${unlocked.length}개를 지웠습니다`);
          useDrawingSession.getState().select(cellId, []);
        }}>잠금 외 삭제</button>
      </div>
    </aside>
  );
}
