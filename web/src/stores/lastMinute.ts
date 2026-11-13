import { isMinutePeriod } from "../lib/symbol";
import { useLayoutStore } from "./layout";
import { useSelectionStore } from "./selection";
import { useUiStore } from "./ui";

export function followLastMinute(): () => void {
  const remember = () => {
    const { activeSlot } = useSelectionStore.getState();
    const { cells } = useLayoutStore.getState().layout;
    const period = (cells.find((c) => c.slot === activeSlot) ?? cells[0])?.period;
    if (period && isMinutePeriod(period)) useUiStore.getState().setLastMinute(period);
  };
  remember();
  const stopLayout = useLayoutStore.subscribe((s, prev) => s.layout !== prev.layout && remember());
  const stopSelection = useSelectionStore.subscribe((s, prev) => s.activeSlot !== prev.activeSlot && remember());
  return () => {
    stopLayout();
    stopSelection();
  };
}
