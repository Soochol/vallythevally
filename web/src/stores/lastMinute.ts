import { isMinutePeriod } from "../lib/symbol";
import { chartWindow, useLayoutStore } from "./layout";
import { useSelectionStore } from "./selection";
import { useUiStore } from "./ui";

export function followLastMinute(): () => void {
  const remember = () => {
    const { activeCell } = useSelectionStore.getState();
    const { period } = chartWindow(useLayoutStore.getState().layout, activeCell);
    if (isMinutePeriod(period)) useUiStore.getState().setLastMinute(period);
  };
  remember();
  const stopLayout = useLayoutStore.subscribe((s, prev) => s.layout !== prev.layout && remember());
  const stopSelection = useSelectionStore.subscribe((s, prev) => s.activeCell !== prev.activeCell && remember());
  return () => {
    stopLayout();
    stopSelection();
  };
}
