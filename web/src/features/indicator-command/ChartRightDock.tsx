import { useEffect, useRef, useState } from "react";
import type { IndicatorKind } from "../../chart/indicators/kinds";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useCell } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartDockMode, type ChartPanelMode } from "../../stores/selection";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { ObjectTreeBody } from "../drawings/ObjectTree";
import { CloseIcon, Icon, SearchIcon } from "../icons";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { CompareSection } from "./CompareSection";
import { DockLayerList, type DockSelectionTarget } from "./DockLayerList";
import { DockLeftDetail } from "./DockLeftDetail";
import { DockQuickAdd } from "./DockQuickAdd";
import type { AddCategory } from "./model";
import { useIndicatorCommand } from "./useIndicatorCommand";

export const CHART_DOCK_MIN_WIDTH = 640;
const DETAIL_NARROW_WIDTH = 660;
const MA_GROUP_SENTINEL = "__ma_group__";

type DockTab = "layers" | "drawings" | "chart";

function tabOfMode(mode: ChartDockMode): DockTab {
  if (mode === "drawings") return "drawings";
  if (mode === "settings" || mode === "compare") return "chart";
  return "layers";
}

function DockRightPinIcon({ size = 13 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
    </Icon>
  );
}

function DockCompareBody({ cellId }: { cellId: WindowId }) {
  const command = useIndicatorCommand(cellId, "compare", null);
  const { input, rows, symbols, search, compareButton } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const symbolRows = rows.filter((row): row is Extract<typeof row, { kind: "symbol" }> => row.kind === "symbol");

  return (
    <div className="b3-compare-tab">
      <label className="ic-search cd-search">
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

export function ChartRightDock({ cellId, hostRef }: { cellId: WindowId; hostRef: React.RefObject<HTMLElement | null> }) {
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

  const canSnap = cellWidth === 0 || cellWidth >= CHART_DOCK_MIN_WIDTH;
  const isSnapped = active.snapped && canSnap;
  const narrow = cellWidth > 0 && cellWidth < DETAIL_NARROW_WIDTH;

  return (
    <ChartRightDockBody
      cellId={cellId}
      hostRef={hostRef}
      mode={active.mode}
      indicatorId={active.indicatorId}
      isSnapped={isSnapped}
      canSnap={canSnap}
      narrow={narrow}
    />
  );
}

function ChartRightDockBody({
  cellId,
  hostRef,
  mode,
  indicatorId,
  isSnapped,
  canSnap,
  narrow,
}: {
  cellId: WindowId;
  hostRef: React.RefObject<HTMLElement | null>;
  mode: ChartDockMode;
  indicatorId: string | null;
  isSnapped: boolean;
  canSnap: boolean;
  narrow: boolean;
}) {
  const cell = useCell(cellId);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddCategory, setQuickAddCategory] = useState<AddCategory>("all");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [chartSubTab, setChartSubTab] = useState<"settings" | "compare">(() => (mode === "compare" ? "compare" : "settings"));
  const quickInputRef = useRef<HTMLInputElement>(null);

  const tab = tabOfMode(mode);

  useEffect(() => {
    if (mode === "compare") setChartSubTab("compare");
    else if (mode === "settings") setChartSubTab("settings");
  }, [mode]);

  const selectedTarget: DockSelectionTarget = (() => {
    if (tab !== "layers" || !indicatorId) return null;
    if (indicatorId === MA_GROUP_SENTINEL) {
      return cell.chartSettings.indicators.some((item) => item.spec.kind === "ma") ? { kind: "maGroup" } : null;
    }
    const found = cell.chartSettings.indicators.find((item) => item.id === indicatorId);
    if (!found) return null;
    return { kind: "indicator", id: found.id };
  })();

  const setSelectedTarget = (target: DockSelectionTarget) => {
    const nextId = target === null ? null : target.kind === "maGroup" ? MA_GROUP_SENTINEL : target.id;
    useSelectionStore.getState().selectChartDockIndicator(nextId);
  };

  useEffect(() => {
    if (!selectedTarget) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!hostRef.current?.contains(target)) return;
      if (target.closest("[data-chart-control], .ui-popover, [role='dialog']")) return;
      setSelectedTarget(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [selectedTarget, hostRef]);

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
    setQuickAddCategory(category);
    setQuickAddOpen(true);
    quickInputRef.current?.focus();
  };

  const handleAdded = (createdId: string, kind: IndicatorKind) => {
    if (kind === "ma") {
      setSelectedTarget({ kind: "maGroup" });
      return;
    }
    setSelectedTarget({ kind: "indicator", id: createdId });
  };

  const modalMode: ChartPanelMode = mode === "drawings" ? defaultIndicatorMode(cellId) : mode;
  const modalIndicatorId = selectedTarget?.kind === "indicator" ? selectedTarget.id : null;

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
        return;
      }
      if (!isSnapped) {
        event.preventDefault();
        useSelectionStore.getState().closeChartDock();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [quickAddOpen, cleanupOpen, selectedTarget, isSnapped]);

  return (
    <div
      className="b3-dock-cluster"
      data-snapped={isSnapped ? "true" : "false"}
      data-detail-open={selectedTarget ? "true" : "false"}
      data-narrow={narrow ? "true" : "false"}
    >
      {selectedTarget && (
        <DockLeftDetail
          cellId={cellId}
          target={selectedTarget}
          indicators={cell.chartSettings.indicators}
          narrow={narrow}
          onClose={() => setSelectedTarget(null)}
        />
      )}

      <aside data-chart-control="" aria-label="차트 우측 설정 패널" className="b3-master">
        <header className="b3-head">
          <div role="group" aria-label="차트 설정 영역" className="ic-section-seg b3-seg">
            <button type="button" aria-pressed={tab === "layers"} onClick={() => switchTab("layers")}>레이어</button>
            <button type="button" aria-pressed={tab === "drawings"} onClick={() => switchTab("drawings")}>드로잉</button>
            <button type="button" aria-label="차트 설정" aria-pressed={tab === "chart"} onClick={() => switchTab("chart")}>차트</button>
          </div>
          <div className="b3-head-actions">
            <button
              type="button"
              className="b3-snap-btn"
              disabled={!canSnap}
              aria-pressed={isSnapped}
              aria-label={isSnapped ? "글래스 피크로 전환" : "우측 고정 도킹"}
              title={!canSnap ? "좁은 차트에서는 글래스 피크로 표시됩니다" : isSnapped ? "글래스 피크로 전환 (차트 폭 유지)" : "우측에 고정 도킹"}
              onClick={() => useSelectionStore.getState().setChartDockSnapped(!isSnapped)}
            >
              <DockRightPinIcon size={12} />
              <span>{isSnapped ? "고정" : "피크"}</span>
            </button>
            <button
              type="button"
              className="cd-mode-btn"
              aria-label="가운데 모달로 전환"
              title="가운데 모달로 전환"
              onClick={() => useSelectionStore.getState().openIndicatorDialog(cellId, modalMode, modalIndicatorId)}
            >
              모달
            </button>
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
          <div className="b3-layers-tab">
            <DockQuickAdd
              cellId={cellId}
              indicators={cell.chartSettings.indicators}
              open={quickAddOpen}
              category={quickAddCategory}
              onOpenChange={setQuickAddOpen}
              onCategoryChange={setQuickAddCategory}
              onAdded={handleAdded}
              onSelectMaGroup={() => setSelectedTarget({ kind: "maGroup" })}
              inputRef={quickInputRef}
            />
            <DockLayerList
              cellId={cellId}
              settings={cell.chartSettings}
              selectedTarget={selectedTarget}
              isSnapped={isSnapped}
              onSelectTarget={setSelectedTarget}
              onOpenQuickAdd={openQuickAdd}
              cleanupOpen={cleanupOpen}
              onCleanupOpenChange={setCleanupOpen}
            />
          </div>
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
    </div>
  );
}
