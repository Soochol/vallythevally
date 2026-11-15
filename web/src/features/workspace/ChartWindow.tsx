import { useState } from "react";
import type { CellStatus } from "../../chart/ChartController";
import type { WindowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import { DrawingToolbar } from "../drawings/DrawingToolbar";
import { ChartCell } from "../grid/ChartCell";

export function ChartWindow({ id }: { id: WindowId }) {
  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });
  const active = useSelectionStore((s) => s.activeCell === id);
  const choose = () => useSelectionStore.getState().setActiveCell(id);
  return (
    <div data-chart-overlay-host className="relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1" onPointerDownCapture={choose} onFocusCapture={choose}>
      {active && <DrawingToolbar />}
      <ChartCell cellId={id} status={status} onStatus={setStatus} />
    </div>
  );
}
