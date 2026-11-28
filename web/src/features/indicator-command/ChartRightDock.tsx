import { useEffect, useMemo, useRef, useState } from "react";
import type { IndicatorKind } from "../../chart/indicators/kinds";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useCell, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartDockMode } from "../../stores/selection";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { ObjectTreeBody } from "../drawings/ObjectTree";
import { CloseIcon, MoreIcon, SearchIcon } from "../icons";
import { isMaConfig } from "../indicator-dialog/MaGroupEditor";
import { removeIndicatorsWithUndo } from "../indicator-inspector/removalUndo";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { CompareSection } from "./CompareSection";
import { DockLayerList, type DockSelectionTarget } from "./DockLayerList";
import { DockLeftDetail } from "./DockLeftDetail";
import { DockQuickAdd } from "./DockQuickAdd";
import type { AddCategory } from "./model";
import { useIndicatorCommand } from "./useIndicatorCommand";

export const CHART_DOCK_WIDE_MIN = 600;
export const CHART_DOCK_COMPACT_MIN = 480;
export type ChartDockLayout = "wide" | "compact" | "overlay";

const MA_GROUP_SENTINEL = "__ma_group__";

type DockTab = "layers" | "drawings" | "chart";

export function chartDockLayoutFor(cellWidth: number): ChartDockLayout {
  if (cellWidth === 0 || cellWidth >= CHART_DOCK_WIDE_MIN) return "wide";
  if (cellWidth >= CHART_DOCK_COMPACT_MIN) return "compact";
  return "overlay";
}

function tabOfMode(mode: ChartDockMode): DockTab {
  if (mode === "drawings") return "drawings";
  if (mode === "settings" || mode === "compare") return "chart";
  return "layers";
}

function DockCompareBody({ cellId }: { cellId: WindowId }) {
  const command = useIndicatorCommand(cellId, "compare", null);
  const { input, rows, symbols, search, compareButton } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const symbolRows = rows.filter((row): row is Extract<typeof row, { kind: "symbol" }> => row.kind === "symbol");

  return (
    <div className="b3-compare-tab">
      <label className="b3-search-box b3-compare-search">
        <SearchIcon size={14} />
        <input
          ref={inputRef}
          type="search"
          aria-label="비교 종목 찾기"
          value={input}
          autoComplete="off"
          spellCheck={false}
          placeholder="비교할 종목 이름·코드"
          onChange={(e) => command.type(e.target.value)}
        />
        {input !== "" && (
          <button
            type="button"
            className="ic-search-clear"
            aria-label="입력 지우기"
            onClick={() => {
              command.type("");
              inputRef.current?.focus();
            }}
          >
            <CloseIcon size={11} />
          </button>
        )}
      </label>
      <CompareSection cellId={cellId} button={compareButton} className="cd-compare-top" />
      <ul className="cd-list">
        {symbolRows.map((row) => (
          <li key={row.key} className="cd-row">
            <button
              type="button"
              className="cd-row-main"
              disabled={!row.selectable}
              onClick={() => row.selectable && command.addCompareSymbol(row.info)}
            >
              <span className="ic-row-title">{row.info.name}</span>
              <span className="ic-row-sub">{symbolSub(row.info.code, row.info)}</span>
            </button>
          </li>
        ))}
        {symbolRows.length === 0 && !(search.isFetching || search.isError) && (
          <li>
            <EmptyState
              title="맞는 종목이 없습니다"
              action="입력 지우기"
              onAction={() => {
                command.type("");
                inputRef.current?.focus();
              }}
            >
              종목 이름·코드·초성으로 찾아보세요.
            </EmptyState>
          </li>
        )}
        {!symbols.selectable && search.isFetching && (
          <li><Skeleton label="비교 종목 찾는 중" /></li>
        )}
        {search.isError && (
          <li><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>
        )}
      </ul>
    </div>
  );
}

export function ChartRightDock({
  cellId,
  hostRef,
  hideDrawings = false,
}: {
  cellId: WindowId;
  hostRef: React.RefObject<HTMLElement | null>;
  hideDrawings?: boolean;
}) {
  const dock = useSelectionStore((s) => s.chartDock);
  const active = dock?.cellId === cellId ? dock : null;
  const [cellWidth, setCellWidth] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (cellDrawing(useDrawingSession.getState(), cellId).objectTreeOpen) {
      useDrawingSession.getState().patchCell(cellId, { objectTreeOpen: false, hoveredId: null });
    }
  }, [active?.cellId, cellId]);

  useEffect(() => {
    if (!active) return;
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setCellWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active?.cellId, hostRef]);

  if (!active) return null;

  return (
    <ChartRightDockBody
      cellId={cellId}
      mode={hideDrawings && active.mode === "drawings" ? defaultIndicatorMode(cellId) : active.mode}
      indicatorId={active.indicatorId}
      layout={chartDockLayoutFor(cellWidth)}
      hideDrawings={hideDrawings}
    />
  );
}

function ChartRightDockBody({
  cellId,
  mode,
  indicatorId,
  layout,
  hideDrawings,
}: {
  cellId: WindowId;
  mode: ChartDockMode;
  indicatorId: string | null;
  layout: ChartDockLayout;
  hideDrawings: boolean;
}) {
  const cell = useCell(cellId);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddCategory, setQuickAddCategory] = useState<AddCategory>("all");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [chartSubTab, setChartSubTab] = useState<"settings" | "compare">(() => (mode === "compare" ? "compare" : "settings"));
  const quickInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<HTMLDivElement>(null);

  const tab = tabOfMode(mode);

  useEffect(() => {
    if (mode === "compare") setChartSubTab("compare");
    else if (mode === "settings") setChartSubTab("settings");
  }, [mode]);

  useEffect(() => {
    if (!cleanupOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (cleanupRef.current && event.target instanceof Node && !cleanupRef.current.contains(event.target)) {
        setCleanupOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [cleanupOpen]);

  const maLines = useMemo(() => cell.chartSettings.indicators.filter(isMaConfig), [cell.chartSettings.indicators]);
  const hiddenIndicators = useMemo(
    () => cell.chartSettings.indicators.filter((item) => !item.visible),
    [cell.chartSettings.indicators],
  );
  const subPanels = useMemo(
    () =>
      cell.chartSettings.panels
        .map((panel) => ({
          panel,
          members: cell.chartSettings.indicators.filter((item) => item.panel === panel.id),
        }))
        .filter((entry) => entry.members.length > 0),
    [cell.chartSettings.panels, cell.chartSettings.indicators],
  );
  const allSubPanelsCollapsed = subPanels.length > 0 && subPanels.every((entry) => entry.panel.collapsed);

  const selectedTarget: DockSelectionTarget = (() => {
    if (tab !== "layers" || !indicatorId) return null;
    if (indicatorId === MA_GROUP_SENTINEL) {
      return maLines.length > 0 ? { kind: "maGroup" } : null;
    }
    const found = cell.chartSettings.indicators.find((item) => item.id === indicatorId);
    if (!found) return null;
    return { kind: "indicator", id: found.id };
  })();

  const setSelectedTarget = (target: DockSelectionTarget) => {
    const nextId = target === null ? null : target.kind === "maGroup" ? MA_GROUP_SENTINEL : target.id;
    useSelectionStore.getState().selectChartDockIndicator(nextId);
  };

  const switchTab = (next: DockTab) => {
    setQuickAddOpen(false);
    setCleanupOpen(false);
    const nextMode: ChartDockMode =
      next === "drawings"
        ? "drawings"
        : next === "chart"
          ? chartSubTab
          : defaultIndicatorMode(cellId);
    useSelectionStore.getState().openChartDock(cellId, nextMode, null);
  };

  const openQuickAdd = (category: AddCategory) => {
    setSelectedTarget(null);
    setCleanupOpen(false);
    setQuickAddCategory(category);
    setQuickAddOpen(true);
    requestAnimationFrame(() => quickInputRef.current?.focus());
  };

  const handleAdded = (createdId: string, kind: IndicatorKind, keepOpen: boolean) => {
    if (keepOpen) return;
    setQuickAddOpen(false);
    if (kind === "ma") {
      setSelectedTarget({ kind: "maGroup" });
      return;
    }
    setSelectedTarget({ kind: "indicator", id: createdId });
  };

  const toggleAllSubPanels = () => {
    const store = useLayoutStore.getState();
    for (const entry of subPanels) {
      if (entry.panel.collapsed !== !allSubPanelsCollapsed) {
        store.togglePanel(cellId, entry.panel.id);
      }
    }
    setCleanupOpen(false);
  };

  const showAllHidden = () => {
    const store = useLayoutStore.getState();
    for (const item of hiddenIndicators) store.updateIndicator(cellId, item.id, { visible: true });
    setCleanupOpen(false);
  };

  const removeAllHidden = () => {
    if (selectedTarget?.kind === "indicator" && hiddenIndicators.some((item) => item.id === selectedTarget.id)) {
      setSelectedTarget(null);
    }
    if (selectedTarget?.kind === "maGroup" && maLines.length > 0 && maLines.every((item) => !item.visible)) {
      setSelectedTarget(null);
    }
    removeIndicatorsWithUndo(cellId, hiddenIndicators, `숨긴 지표 ${hiddenIndicators.length}개를 지웠습니다`);
    setCleanupOpen(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (useSelectionStore.getState().dialog !== null) return;
      if (document.querySelector(".ui-popover:popover-open, [role='dialog']")) return;
      if (quickAddOpen) {
        event.preventDefault();
        setQuickAddOpen(false);
        quickInputRef.current?.blur();
        return;
      }
      if (cleanupOpen) {
        event.preventDefault();
        setCleanupOpen(false);
        return;
      }
      if (selectedTarget) {
        event.preventDefault();
        setSelectedTarget(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [quickAddOpen, cleanupOpen, selectedTarget]);

  const showCleanupButton = tab === "layers" && !selectedTarget && !quickAddOpen;

  return (
    <aside
      data-chart-control=""
      data-layout={layout}
      aria-label="차트 우측 설정 패널"
      className="b3-master"
    >
      <header className="b3-head">
        <div role="group" aria-label="차트 설정 영역" className="ic-section-seg b3-seg">
          <button type="button" aria-pressed={tab === "layers"} onClick={() => switchTab("layers")}>레이어</button>
          {!hideDrawings && <button type="button" aria-pressed={tab === "drawings"} onClick={() => switchTab("drawings")}>드로잉</button>}
          <button type="button" aria-label="차트 설정" aria-pressed={tab === "chart"} onClick={() => switchTab("chart")}>차트</button>
        </div>
        <div className="b3-head-actions">
          {showCleanupButton && (
            <div ref={cleanupRef} className="b3-cleanup-wrap">
              <button
                type="button"
                className="icon-btn size-6"
                aria-label="레이어 정리 메뉴"
                aria-expanded={cleanupOpen}
                title="레이어 정리"
                onClick={() => setCleanupOpen((open) => !open)}
              >
                <MoreIcon size={14} />
              </button>
              {cleanupOpen && (
                <div className="b3-cleanup-menu" role="menu" aria-label="레이어 정리">
                  <button type="button" role="menuitem" disabled={subPanels.length === 0} onClick={toggleAllSubPanels}>
                    {allSubPanelsCollapsed ? "아래 패널 모두 펼치기" : "아래 패널 모두 접기"}
                  </button>
                  <button type="button" role="menuitem" disabled={hiddenIndicators.length === 0} onClick={showAllHidden}>
                    숨긴 지표 모두 보이기 ({hiddenIndicators.length})
                  </button>
                  <button type="button" role="menuitem" className="b3-cleanup-danger" disabled={hiddenIndicators.length === 0} onClick={removeAllHidden}>
                    숨긴 지표 모두 삭제 ({hiddenIndicators.length})
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="icon-btn size-6"
            aria-label="닫기"
            title="닫기"
            onClick={() => useSelectionStore.getState().closeChartDock()}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      {tab === "layers" && (
        selectedTarget ? (
          <DockLeftDetail
            cellId={cellId}
            target={selectedTarget}
            indicators={cell.chartSettings.indicators}
            onSelectTarget={setSelectedTarget}
            onClose={() => setSelectedTarget(null)}
          />
        ) : (
          <div className="b3-layers-tab">
            <DockQuickAdd
              cellId={cellId}
              indicators={cell.chartSettings.indicators}
              open={quickAddOpen}
              category={quickAddCategory}
              onOpenChange={setQuickAddOpen}
              onCategoryChange={setQuickAddCategory}
              onAdded={handleAdded}
              onSelectMaGroup={() => {
                setQuickAddOpen(false);
                setSelectedTarget({ kind: "maGroup" });
              }}
              inputRef={quickInputRef}
            />
            {!quickAddOpen && (
              <DockLayerList
                cellId={cellId}
                settings={cell.chartSettings}
                selectedTarget={selectedTarget}
                onSelectTarget={setSelectedTarget}
                onOpenQuickAdd={openQuickAdd}
              />
            )}
          </div>
        )
      )}

      {tab === "drawings" && (
        <div className="b3-drawings-body">
          <ObjectTreeBody cellId={cellId} />
        </div>
      )}

      {tab === "chart" && (
        <div className="b3-chart-tab">
          <div className="b3-sub-seg" role="group" aria-label="차트 설정 하위 영역">
            <button
              type="button"
              aria-pressed={chartSubTab === "settings"}
              onClick={() => {
                setChartSubTab("settings");
                useSelectionStore.getState().openChartDock(cellId, "settings", null);
              }}
            >
              차트 설정
            </button>
            <button
              type="button"
              aria-pressed={chartSubTab === "compare"}
              onClick={() => {
                setChartSubTab("compare");
                useSelectionStore.getState().openChartDock(cellId, "compare", null);
              }}
            >
              비교 종목{cell.chartSettings.compare.length > 0 ? ` (${cell.chartSettings.compare.length})` : ""}
            </button>
          </div>
          {chartSubTab === "settings" ? (
            <div className="cd-settings-body">
              <ChartSettingsSections cellId={cellId} compact />
            </div>
          ) : (
            <DockCompareBody cellId={cellId} />
          )}
        </div>
      )}
    </aside>
  );
}
