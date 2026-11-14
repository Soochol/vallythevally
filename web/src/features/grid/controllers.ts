import type { ChartController } from "../../chart/ChartController";
import type { WindowId } from "../../layout/kinds";

const byCell = new Map<WindowId, ChartController>();

export function attachController(cellId: WindowId, controller: ChartController): () => void {
  byCell.set(cellId, controller);
  return () => {
    if (byCell.get(cellId) === controller) byCell.delete(cellId);
  };
}

export function controllerFor(cellId: WindowId): ChartController | undefined {
  return byCell.get(cellId);
}
