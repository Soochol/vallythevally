import type { IndicatorSpec } from "../../chart/indicators/kinds";
import { compareRefusal, type IndicatorConfig } from "../../chart/settings";
import { useLayoutStore, type Slot } from "../../stores/layout";

type Command = { kind: "indicator"; id: string | null; spec: IndicatorSpec; style: IndicatorConfig["style"] }
  | { kind: "compare"; code: string };

export function executeCommand(slot: Slot, command: Command): boolean {
  const store = useLayoutStore.getState();
  const cell = store.layout.cells.find((cell) => cell.slot === slot);
  if (!cell) return false;
  if (command.kind === "compare") {
    if (compareRefusal(cell.chartSettings, command.code, cell.symbol)) return false;
    store.addCompare(slot, command.code);
  } else if (command.id === null) store.addIndicator(slot, command.spec, command.style);
  else {
    if (!cell.chartSettings.indicators.some((config) => config.id === command.id && config.spec.kind === command.spec.kind)) return false;
    store.updateIndicator(slot, command.id, { spec: command.spec, style: command.style });
  }
  return true;
}
