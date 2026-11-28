import { specName } from "../../chart/indicators/kinds";
import { type IndicatorConfig, placementOfConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { findChartCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export function restoreIndicator(cellId: WindowId, config: IndicatorConfig): IndicatorConfig | null {
  const layout = useLayoutStore.getState();
  const createdId = layout.addIndicator(cellId, config.spec, config.style, placementOfConfig(config));
  if (!createdId) return null;
  if (!config.visible) useLayoutStore.getState().updateIndicator(cellId, createdId, { visible: false });
  if (config.axis && config.axis !== "auto") useLayoutStore.getState().setIndicatorAxis(cellId, createdId, config.axis);
  return findChartCell(useLayoutStore.getState(), cellId)?.chartSettings.indicators.find((item) => item.id === createdId) ?? null;
}

export function restoreIndicators(cellId: WindowId, configs: readonly IndicatorConfig[]): void {
  const restoredPanels = new Map<string, string>();
  for (const config of configs) {
    const restored = restoreIndicator(cellId, config);
    if (!restored || config.panel === "price") continue;
    const sharedPanel = restoredPanels.get(config.panel);
    if (sharedPanel) {
      useLayoutStore.getState().mergeIndicatorIntoPanel(cellId, restored.id, sharedPanel);
      if (config.axis && config.axis !== "auto") useLayoutStore.getState().setIndicatorAxis(cellId, restored.id, config.axis);
    } else {
      restoredPanels.set(config.panel, restored.panel);
    }
  }
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

export function removeIndicatorsWithUndo(cellId: WindowId, configs: readonly IndicatorConfig[], toastText: string): void {
  if (configs.length === 0) return;
  if (configs.length === 1) {
    removeIndicatorWithUndo(cellId, configs[0]!);
    return;
  }
  const snapshot = configs.map((config) => structuredClone(config));
  const store = useLayoutStore.getState();
  for (const config of snapshot) store.removeIndicator(cellId, config.id);
  let used = false;
  useSelectionStore.getState().showToast(toastText, {
    available: () => !used,
    run: () => {
      if (used) return;
      used = true;
      restoreIndicators(cellId, snapshot);
    },
    subscribe: () => () => undefined,
  });
}
