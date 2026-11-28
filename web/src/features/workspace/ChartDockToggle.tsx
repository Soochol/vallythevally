import type { WindowId } from "../../layout/kinds";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { ListIcon } from "../icons";

export function ChartDockToggle({ id }: { id: WindowId }) {
  const cell = useCell(id);
  const open = useSelectionStore((s) => s.chartDock?.cellId === id);
  const count = cell.chartSettings.indicators.length;
  const label = open ? "지표 레이어 닫기" : "지표 레이어 열기";

  return (
    <button
      type="button"
      className="dock-indicator-toggle max-md:hidden"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => useSelectionStore.getState().toggleChartDock(id)}
    >
      <ListIcon size={12} />
      <span className="dock-indicator-label">지표</span>
      <span className="dock-indicator-count">{count}</span>
    </button>
  );
}
