import type { WindowId } from "../../layout/kinds";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { isChartSettingsModified } from "../chart-settings/ChartSettingsDialog";
import { CogIcon } from "../icons";

export function ChartSettingsButton({ cellId, variant = "dock" }: { cellId: WindowId; variant?: "dock" | "window" }) {
  const open = useSelectionStore((s) => s.chartRightPanels[cellId] !== undefined);
  const settings = useCell(cellId).chartSettings;
  const modified = isChartSettingsModified(settings);
  const className = variant === "dock" ? "dock-chart-settings max-md:hidden" : "window-action window-chart-settings max-md:hidden";

  return (
    <button
      type="button"
      className={className}
      data-chart-panel-toggle={cellId}
      data-modified={modified ? "true" : undefined}
      aria-label="차트 설정 패널"
      aria-pressed={open}
      title={open ? "차트 설정 패널 닫기" : "차트 설정 패널 열기"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => useSelectionStore.getState().toggleChartRightPanel(cellId, "indicators")}
    >
      <CogIcon size={14} />
      <span aria-hidden="true" className="dock-chart-settings-dot" />
    </button>
  );
}
