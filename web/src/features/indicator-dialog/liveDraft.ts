import { useEffect, useState } from "react";
import { colorsFrom } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { checkForm, startDraft } from "./indicatorForm";
import { useValidator } from "./IndicatorSettingsForm";
import type { WindowId } from "../../layout/kinds";

export function useLiveIndicatorDraft(cellId: WindowId, initial: IndicatorConfig) {
  const [draft, setDraft] = useState(() => startDraft(initial, initial.spec.kind));
  const validator = useValidator();
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const color = draft.color === "auto" ? initial.style.colors[0] ?? "ind-1" : draft.color;
  const originalColor = startDraft(initial, initial.spec.kind).color;

  useEffect(() => {
    if (!check.ok) return;
    const current = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id);
    if (!current) return;
    const spec = JSON.stringify(current.spec) === JSON.stringify(check.spec) ? current.spec : check.spec;
    const colors = color === originalColor ? initial.style.colors : colorsFrom(spec, color);
    const style = current.style.width === draft.width && JSON.stringify(current.style.colors) === JSON.stringify(colors) ? current.style : { colors, width: draft.width };
    if (spec !== current.spec || style !== current.style) useLayoutStore.getState().updateIndicator(cellId, initial.id, { spec, style });
  }, [draft, validator, cellId, initial]);

  const revert = () => useLayoutStore.getState().updateIndicator(cellId, initial.id, { spec: initial.spec, style: initial.style });

  return { draft, setDraft, validator, check, color, revert };
}
