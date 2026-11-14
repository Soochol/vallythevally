import { useMemo } from "react";
import { create } from "zustand";
import type { IndicatorSpec } from "../../chart/indicators/kinds";
import { addIndicator, updateIndicator, type ChartSettings, type IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";

export type Preview = { kind: "add"; id: string; panelId: string; spec: IndicatorSpec; style: IndicatorConfig["style"] }
  | { kind: "edit"; id: string; spec: IndicatorSpec; style: IndicatorConfig["style"] };

export const useIndicatorPreview = create<{ current: { cellId: WindowId; preview: Preview } | null; set(cellId: WindowId, preview: Preview | null): void }>()((set) => ({
  current: null,
  set: (cellId, preview) => set({ current: preview ? { cellId, preview } : null }),
}));

export function previewSettings(settings: ChartSettings, preview: Preview | null): ChartSettings {
  if (!preview) return settings;
  if (preview.kind === "edit") return updateIndicator(settings, preview.id, { spec: preview.spec, style: preview.style });
  let nextId = 0;
  return addIndicator(settings, preview.spec, preview.style, () => nextId++ === 0 ? preview.id : preview.panelId).settings;
}

export function useShownSettings(cellId: WindowId, saved: ChartSettings): { settings: ChartSettings; preview: Preview | null } {
  const preview = useIndicatorPreview((s) => s.current?.cellId === cellId ? s.current.preview : null);
  const settings = useMemo(() => previewSettings(saved, preview), [saved, preview]);
  return { settings, preview };
}
