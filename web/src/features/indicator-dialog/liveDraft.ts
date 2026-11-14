import { useEffect, useState } from "react";
import { colorsFrom } from "../../chart/indicators/kinds";
import { type IndicatorConfig, barOpacityOf, placementOfConfig } from "../../chart/settings";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { checkForm, draftStyle, startDraft } from "./indicatorForm";
import { useValidator } from "./IndicatorSettingsForm";
import type { WindowId } from "../../layout/kinds";

export function useLiveIndicatorDraft(cellId: WindowId, initial: IndicatorConfig) {
  const [draft, setDraft] = useState(() => startDraft(initial, initial.spec.kind));
  const validator = useValidator();
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const color = draft.color === "auto" ? initial.style.colors[0] ?? "ind-1" : draft.color;
  const originalColor = startDraft(initial, initial.spec.kind).color;
  const [panelId] = useState(() => initial.panel === "price" ? crypto.randomUUID() : initial.panel);

  useEffect(() => {
    const store = useLayoutStore.getState();
    const current = chartWindows(store.layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id);
    if (!current) return;
    if (placementOfConfig(current) !== draft.placement) store.setIndicatorPlacement(cellId, initial.id, draft.placement, panelId);
    if (!check.ok) return;
    const spec = JSON.stringify(current.spec) === JSON.stringify(check.spec) ? current.spec : check.spec;
    const colors = color === originalColor ? initial.style.colors : colorsFrom(spec, color);
    const next = draftStyle(draft, colors);
    const style = current.style.width === next.width && JSON.stringify(current.style.colors) === JSON.stringify(colors) && barOpacityOf(current.style) === barOpacityOf(next) ? current.style : next;
    if (spec !== current.spec || style !== current.style) store.updateIndicator(cellId, initial.id, { spec, style });
  }, [draft, validator, cellId, initial]);

  const revert = () => {
    const store = useLayoutStore.getState();
    store.updateIndicator(cellId, initial.id, { spec: initial.spec, style: initial.style });
    store.setIndicatorPlacement(cellId, initial.id, placementOfConfig(initial), panelId);
  };

  return { draft, setDraft, validator, check, color, revert };
}
