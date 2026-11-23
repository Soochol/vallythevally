import { specName } from "../../chart/indicators/kinds";
import { type IndicatorConfig, placementOfConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export function restoreIndicator(cellId: WindowId, config: IndicatorConfig): void {
  const layout = useLayoutStore.getState();
  layout.addIndicator(cellId, config.spec, config.style, placementOfConfig(config));
  if (config.visible) return;
  const restored = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.at(-1);
  if (restored) useLayoutStore.getState().updateIndicator(cellId, restored.id, { visible: false });
}

export function removeIndicatorWithUndo(cellId: WindowId, config: IndicatorConfig): void {
  useLayoutStore.getState().removeIndicator(cellId, config.id);
  let used = false;
  useSelectionStore.getState().showToast(`${specName(config.spec)} 지표를 지웠습니다`, {
    available: () => !used,
    run: () => {
      if (used) return;
      used = true;
      restoreIndicator(cellId, config);
    },
    subscribe: () => () => undefined,
  });
}
