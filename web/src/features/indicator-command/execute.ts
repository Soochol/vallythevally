import type { IndicatorSpec, Placement } from "../../chart/indicators/kinds";
import { compareRefusal, type IndicatorConfig } from "../../chart/settings";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import type { WindowId } from "../../layout/kinds";

type Command = { kind: "indicator"; id: string | null; spec: IndicatorSpec; style: IndicatorConfig["style"]; placement: Placement }
  | { kind: "compare"; code: string };

export function executeCommand(cellId: WindowId, command: Command): boolean {
  const store = useLayoutStore.getState();
  const cell = chartWindows(store.layout).find((cell) => cell.id === cellId);
  if (!cell) return false;
  if (command.kind === "compare") {
    if (compareRefusal(cell.chartSettings, command.code, cell.symbol)) return false;
    store.addCompare(cellId, command.code);
  } else if (command.id === null) store.addIndicator(cellId, command.spec, command.style, command.placement);
  else {
    if (!cell.chartSettings.indicators.some((config) => config.id === command.id && config.spec.kind === command.spec.kind)) return false;
    store.updateIndicator(cellId, command.id, { spec: command.spec, style: command.style });
    store.setIndicatorPlacement(cellId, command.id, command.placement);
  }
  return true;
}
