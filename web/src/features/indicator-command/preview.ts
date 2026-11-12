import { create } from "zustand";
import type { IndicatorSpec } from "../../chart/indicators/kinds";
import { addIndicator, updateIndicator, type ChartSettings, type IndicatorConfig } from "../../chart/settings";
import type { Slot } from "../../stores/layout";

type Preview = { kind: "add"; id: string; panelId: string; spec: IndicatorSpec; style: IndicatorConfig["style"] }
  | { kind: "edit"; id: string; spec: IndicatorSpec; style: IndicatorConfig["style"] };

export const useIndicatorPreview = create<{ current: { slot: Slot; preview: Preview } | null; set(slot: Slot, preview: Preview | null): void }>()((set) => ({
  current: null,
  set: (slot, preview) => set({ current: preview ? { slot, preview } : null }),
}));

export function previewSettings(settings: ChartSettings, preview: Preview | null): ChartSettings {
  if (!preview) return settings;
  if (preview.kind === "edit") return updateIndicator(settings, preview.id, { spec: preview.spec, style: preview.style });
  let nextId = 0;
  return addIndicator(settings, preview.spec, preview.style, () => nextId++ === 0 ? preview.id : preview.panelId).settings;
}
