import { useEffect, useRef, useState } from "react";
import { colorsFrom, specLines } from "../../chart/indicators/kinds";
import { type IndicatorConfig, barOpacityOf, DEFAULT_PANEL_STRETCH, ichimokuStyleOf, placementOfConfig, sameIchimokuStyle } from "../../chart/settings";
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
  const [opened] = useState(() => {
    const panels = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === cellId)?.chartSettings.panels ?? [];
    const at = panels.findIndex((p) => p.id === initial.panel);
    return { panel: panels[at] ?? { id: crypto.randomUUID(), stretch: DEFAULT_PANEL_STRETCH }, at: Math.max(0, at) };
  });
  const placementChanged = useRef(false);

  useEffect(() => {
    const store = useLayoutStore.getState();
    const current = chartWindows(store.layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id);
    if (!current) return;
    if (placementOfConfig(current) !== draft.placement) {
      placementChanged.current = true;
      store.setIndicatorPlacement(cellId, initial.id, draft.placement, { id: opened.panel.id, stretch: DEFAULT_PANEL_STRETCH });
    }
    if (!check.ok) return;
    const spec = JSON.stringify(current.spec) === JSON.stringify(check.spec) ? current.spec : check.spec;
    const colors = color === originalColor && specLines(spec).length === specLines(initial.spec).length
      ? initial.style.colors
      : colorsFrom(spec, color);
    const next = draftStyle(draft, colors);
    const style = current.style.width === next.width
      && JSON.stringify(current.style.colors) === JSON.stringify(colors)
      && barOpacityOf(current.style, current.spec.kind) === barOpacityOf(next, spec.kind)
      && sameIchimokuStyle(ichimokuStyleOf(current.style), ichimokuStyleOf(next))
      ? current.style
      : next;
    if (spec !== current.spec || style !== current.style) store.updateIndicator(cellId, initial.id, { spec, style });
  }, [draft, validator, cellId, initial]);

  const revert = () => {
    const store = useLayoutStore.getState();
    store.updateIndicator(cellId, initial.id, { spec: initial.spec, style: initial.style });
    if (!placementChanged.current) return;
    store.setIndicatorPlacement(cellId, initial.id, "price");
    store.setIndicatorPlacement(cellId, initial.id, placementOfConfig(initial), opened.panel, opened.at);
  };

  return { draft, setDraft, validator, check, color, revert };
}
