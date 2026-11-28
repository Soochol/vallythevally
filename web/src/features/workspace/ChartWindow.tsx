import { useEffect, useRef, useState } from "react";
import type { CellStatus } from "../../chart/ChartController";
import type { WindowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import { ChartCell } from "../grid/ChartCell";
import { CHART_RIGHT_PANEL_DOCK_MIN_WIDTH, ChartRightPanel } from "../indicator-command/ChartRightPanel";

export function ChartWindow({ id }: { id: WindowId }) {
  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });
  const panelOpen = useSelectionStore((s) => s.chartRightPanels[id] !== undefined);
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const choose = () => useSelectionStore.getState().setActiveCell(id);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !panelOpen) return;
    const measure = () => setHostWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panelOpen]);

  const panelOverlay = hostWidth > 0 && hostWidth < CHART_RIGHT_PANEL_DOCK_MIN_WIDTH;

  return (
    <div ref={hostRef} data-chart-overlay-host className="relative flex min-h-0 min-w-0 flex-1" onPointerDownCapture={choose} onFocusCapture={choose}>
      <ChartCell cellId={id} status={status} onStatus={setStatus} />
      <ChartRightPanel cellId={id} overlay={panelOverlay} />
    </div>
  );
}
