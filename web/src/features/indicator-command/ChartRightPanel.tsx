import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import type { WindowId } from "../../layout/kinds";
import { isTypingTarget } from "../../lib/typingTarget";
import { useCell } from "../../stores/layout";
import { type ChartRightPanelTab, useSelectionStore } from "../../stores/selection";
import { ChartSettingsSections, isChartSettingsModified } from "../chart-settings/ChartSettingsDialog";
import { CloseIcon } from "../icons";
import { IndicatorAddPanel } from "./IndicatorAddPanel";
import { isUndoKey, undoChartSettings } from "./settingsHistory";

export const CHART_RIGHT_PANEL_DOCK_MIN_WIDTH = 620;

const TABS: readonly { id: ChartRightPanelTab; label: string }[] = [
  { id: "indicators", label: "지표" },
  { id: "settings", label: "차트 설정" },
];

export function ChartRightPanel({ cellId, overlay }: { cellId: WindowId; overlay: boolean }) {
  const panel = useSelectionStore((s) => s.chartRightPanels[cellId] ?? null);
  const cell = useCell(cellId);
  const id = useId();
  const rootRef = useRef<HTMLElement>(null);
  const open = panel !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const sel = useSelectionStore.getState();
      if (sel.dialog !== null || sel.chartPop !== null) return;
      const inside = event.target instanceof Node && rootRef.current?.contains(event.target) === true;
      if (!inside && sel.activeCell !== cellId) return;
      event.preventDefault();
      sel.closeChartRightPanel(cellId);
      if (inside) {
        document.querySelector<HTMLElement>(`[data-chart-panel-toggle="${CSS.escape(cellId)}"]`)?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cellId]);

  if (!panel) return null;

  const addedCount = cell.chartSettings.indicators.length + cell.chartSettings.compare.length;
  const settingsModified = isChartSettingsModified(cell.chartSettings);
  const tabDomId = (tab: ChartRightPanelTab) => `${id}-${tab}`;
  const close = () => useSelectionStore.getState().closeChartRightPanel(cellId);
  const selectTab = (tab: ChartRightPanelTab) => useSelectionStore.getState().openChartRightPanel(cellId, tab);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: ChartRightPanelTab = panel.tab === "indicators" ? "settings" : "indicators";
    selectTab(next);
    document.getElementById(tabDomId(next))?.focus();
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const command = isUndoKey(event.nativeEvent);
    if (!command || isTypingTarget(event.target)) return;
    event.preventDefault();
    undoChartSettings({ kind: "open" }, command === "redo");
  };

  return (
    <aside
      ref={rootRef}
      role="complementary"
      aria-label="차트 설정 패널"
      data-chart-right-panel={cellId}
      data-overlay={overlay ? "true" : undefined}
      data-chart-control=""
      data-chart-escape-owner=""
      className="crp-panel max-md:hidden"
      onKeyDown={onPanelKeyDown}
    >
      <header className="crp-head">
        <div className="crp-tabs" role="tablist" aria-label="차트 우측 패널" onKeyDown={onTabKeyDown}>
          {TABS.map((item) => (
            <button
              key={item.id}
              id={tabDomId(item.id)}
              type="button"
              role="tab"
              aria-selected={panel.tab === item.id}
              data-modified={item.id === "settings" && settingsModified ? "true" : undefined}
              className="crp-tab"
              onClick={() => selectTab(item.id)}
            >
              <span>{item.label}</span>
              {item.id === "indicators" && addedCount > 0 && <span className="crp-count tabular-nums">{addedCount}</span>}
              {item.id === "settings" && <span aria-hidden="true" className="crp-mod-dot" />}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn crp-close" aria-label="패널 닫기" title="닫기 (Esc)" onClick={close}>
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="crp-body">
        {panel.tab === "indicators" ? (
          <IndicatorAddPanel
            cellId={cellId}
            section={panel.addSection}
            focusNonce={panel.focusNonce}
            embedded
            onSection={(section) => useSelectionStore.getState().setChartRightPanelAddSection(cellId, section)}
          />
        ) : (
          <ChartSettingsSections cellId={cellId} embedded />
        )}
      </div>
    </aside>
  );
}
